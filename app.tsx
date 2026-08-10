import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  Markdown,
  ThreadChat,
} from "@bb/plugin-sdk/app";
import type {
  PluginRpcResult,
  PluginThreadHeaderActionProps,
  PluginThreadPanelProps,
} from "@bb/plugin-sdk/app";
import type { ModelConfiguration, rpcContract } from "./server";

const PANEL_ACTION_ID = "reviews";

/**
 * Every shape below is inferred from the server's own contract rather than
 * mirrored by hand. A field added or renamed on the server is then a
 * typecheck failure here instead of a surface that silently reads `undefined`.
 */
type Contract = typeof rpcContract;
type BadgeData = PluginRpcResult<Contract["threadBadge"]>;
type PanelData = PluginRpcResult<Contract["threadReviews"]>;
type PendingAdviceData = PluginRpcResult<Contract["pendingAdvice"]>;
type PanelReview = PanelData["reviews"][number];
type PanelIncident = PanelData["incidents"][number];
type ReviewLifecycle = PanelData["lifecycle"];

type Severity = PanelReview["severity"];
/** The states a surface can advertise, including the two that are not verdicts. */
type Standing =
  | Severity
  | "unavailable"
  | "reviewing"
  | "waiting"
  | "decided";

type Decision = PanelReview["decision"];

const REVIEW_LIFECYCLE_LABEL: Record<ReviewLifecycle, string> = {
  unreviewed: "Not reviewed",
  waiting: "Waiting for completed turn",
  pending: "Review pending",
  approved: "Approved",
  "changes-requested": "Changes requested",
  decided: "User decided",
  unavailable: "Review unavailable",
};

/** What the user said when they settled a finding. */
const DECISION_LABEL: Record<Exclude<Decision, "">, string> = {
  fixed: "You marked it fixed",
  "not-an-issue": "You said it isn't an issue",
  "wont-fix": "You decided not to fix it",
};

/**
 * One line saying what actually happened to a finding. Every state is a
 * recorded fact — who settled it, or whether its text reached the agent — so
 * the tab never implies an outcome nobody observed.
 */
function lifecycleOf(
  review: PanelReview,
  now: number,
): { text: string; tone: string } {
  if (review.resolvedAt !== null) {
    return {
      text: `${
        review.decision === ""
          ? "You dismissed it"
          : DECISION_LABEL[review.decision]
      } ${formatWhen(review.resolvedAt, now)}`,
      tone: "text-subtle-foreground",
    };
  }
  if (review.closedAt !== null) {
    return {
      text: `Advisor re-checked and closed it${
        review.closedSeq === null ? "" : ` at turn ${review.closedSeq}`
      }`,
      tone: "text-success-foreground",
    };
  }
  if (review.continuedAt !== null) {
    return {
      text: `Corrective follow-up started ${formatWhen(review.continuedAt, now)}`,
      tone: "text-subtle-foreground",
    };
  }
  if (review.repeatCount > 1) {
    return {
      text: `Re-raised ${review.repeatCount}× — not addressed`,
      tone: "text-destructive-text",
    };
  }
  if (review.sentAt !== null) {
    return {
      text: `Sent to the agent ${formatWhen(review.sentAt, now)}`,
      tone: "text-subtle-foreground",
    };
  }
  return {
    text: "Queued — goes to the agent with your next message",
    tone: "text-subtle-foreground",
  };
}

const SEVERITY_RANK: Record<Severity, number> = {
  pass: 0,
  nit: 1,
  concern: 2,
  blocker: 3,
};

/**
 * Severity is carried by a label plus a dot, never by color alone, so it stays
 * legible in both themes and to colorblind users.
 */
const SEVERITY_STYLE: Record<Severity, string> = {
  blocker:
    "text-destructive-text border-surface-destructive-border bg-surface-destructive",
  concern: "text-warning-text border-warning/30 bg-warning/10",
  nit: "text-readback-foreground border-border bg-surface-recessed",
  pass: "text-success-foreground border-success/30 bg-success/10",
};

const CHIP_BASE =
  "inline-flex items-center gap-1.5 rounded-full border px-1.5 py-px text-2xs font-semibold uppercase tracking-wide whitespace-nowrap";

/**
 * The stored severities are the advisor's own vocabulary. "nit" and
 * "unavailable" mean nothing to someone reading their own thread, so every
 * surface shows plain words plus a tooltip saying what the level implies.
 */
const SEVERITY_LABEL: Record<Standing, string> = {
  blocker: "Must fix",
  concern: "Should fix",
  nit: "Minor",
  pass: "No issues",
  unavailable: "Didn't run",
  reviewing: "Review pending",
  waiting: "Waiting",
  decided: "Decided",
};

const SEVERITY_HINT: Record<Standing, string> = {
  blocker: "The advisor found something it thinks must be fixed before this work is finished.",
  concern: "The advisor found a real problem worth fixing, but not a blocking one.",
  nit: "A small suggestion. Safe to ignore.",
  pass: "The advisor reviewed this turn and found nothing actionable.",
  unavailable: "The review did not run, so nothing was checked. This is not an approval.",
  reviewing: "A review is running right now. Nothing has been checked yet.",
  waiting: "Advisor will review when the current agent turn has a completed answer.",
  decided: "The user overruled or accepted the latest finding. Advisor did not verify a fix.",
};

/** Absolute time is noise in a thread you are reading now; elapsed time is not. */
function formatWhen(epochMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

/**
 * Elapsed labels are computed at render, so without a tick "just now" persists
 * for as long as the panel stays open. One minute is the coarsest interval the
 * shortest bucket can tolerate.
 */
function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function SeverityChip({
  severity,
  muted,
  children,
}: {
  severity: Severity;
  muted?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <span
      title={SEVERITY_HINT[severity]}
      className={`${CHIP_BASE} ${SEVERITY_STYLE[severity]} ${muted ? "opacity-60" : ""}`}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      {children ?? SEVERITY_LABEL[severity]}
    </span>
  );
}

function UnavailableChip({ children }: { children?: React.ReactNode }) {
  return (
    <span
      title={SEVERITY_HINT.unavailable}
      className={`${CHIP_BASE} border-dashed border-border bg-transparent text-subtle-foreground`}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      {children ?? SEVERITY_LABEL.unavailable}
    </span>
  );
}

/**
 * A distinct outline per standing. The compact header collapses to an icon, so
 * shape — not tint — has to carry severity there.
 */
const SEVERITY_GLYPH: Record<Standing, string> = {
  // octagon
  blocker: "M8 2h8l6 6v8l-6 6H8l-6-6V8zM12 8v5M12 16.5h.01",
  // triangle
  concern: "M12 3 22 20H2zM12 10v4M12 17.5h.01",
  // circle
  nit: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 8v5M12 16.5h.01",
  // shield with a check
  pass: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zm-3-10 2 2 4-4",
  // dashed-feeling slashed circle
  unavailable: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M6 6l12 12",
  // magnifier: work in progress, deliberately unlike any verdict
  reviewing: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M16 16l4 4",
  // clock: waiting for the current public answer to commit
  waiting: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2",
  // user decision: distinct from Advisor's shield-check approval
  decided: "M5 12l4 4L19 6M12 3a9 9 0 1 0 0 18",
};

function SeverityGlyph({
  standing,
  className,
}: {
  standing: Standing;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={SEVERITY_GLYPH[standing]} />
    </svg>
  );
}

/**
 * Refetch on mount and whenever the server signals this thread changed. The
 * realtime payload is only an invalidation hint: it is broadcast to every
 * client and a reconnecting one may have missed it, so the fetch is the source
 * of truth.
 */
function useThreadAdvisor<
  Method extends "threadReviews" | "threadBadge" | "pendingAdvice",
>(
  // Null on a composer scope with no thread yet: the rpc requires a non-empty
  // id, so calling with a placeholder would guarantee a validation error.
  threadId: string | null,
  method: Method,
) {
  const rpc = useRpc<Contract>();
  const [data, setData] = useState<PluginRpcResult<Contract[Method]> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (threadId === null) return;
    try {
      setError(null);
      setData(await rpc.call(method, { threadId }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [rpc, method, threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(
    "thread-changed",
    useCallback(
      (payload: unknown) => {
        const target =
          typeof payload === "object" && payload !== null
            ? (payload as { threadId?: unknown }).threadId
            : undefined;
        if (target === threadId) void load();
      },
      [threadId, load],
    ),
  );

  // Signals are fire-and-forget: anything published while the socket was down
  // is gone. Reconcile on every transition back to `connected`, or a verdict
  // that landed during the outage stays invisible until a full remount.
  const connection = useRealtimeConnectionState();
  const [wasConnected, setWasConnected] = useState(connection === "connected");
  useEffect(() => {
    if (connection !== "connected") {
      setWasConnected(false);
      return;
    }
    if (wasConnected) return;
    setWasConnected(true);
    void load();
  }, [connection, wasConnected, load]);

  return { data, error, reload: load };
}

function AdvisorHeaderBadge({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const { data } = useThreadAdvisor<"threadBadge">(threadId, "threadBadge");
  if (!data) return null;

  const standing = badgeStanding(data);
  if (!standing) return null;

  return (
    <button
      type="button"
      title={standing.label}
      aria-label={standing.label}
      onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID })}
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs hover:bg-state-hover ${standing.tone}`}
    >
      {/* The glyph differs per standing, so the compact icon-only form still
          distinguishes a blocker from a nit without relying on color. */}
      <SeverityGlyph standing={standing.kind} className="size-3.5 shrink-0" />
      {isCompactViewport ? null : <span>{SEVERITY_LABEL[standing.kind]}</span>}
      {standing.repeatCount > 1 ? (
        <span className="text-2xs font-semibold tabular-nums opacity-85">
          ×{standing.repeatCount}
        </span>
      ) : null}
    </button>
  );
}

const TONE_NEUTRAL = "text-muted-foreground border-border bg-surface-recessed";
const TONE_DASHED =
  "border-dashed border-border bg-transparent text-subtle-foreground";
const TONE_ALARM =
  "text-destructive-text border-surface-destructive-border bg-surface-destructive";

/**
 * Badge precedence. `latest` is deliberately last: a turn that passes does not
 * close an earlier finding, so showing the newest verdict first would let a
 * clean turn advertise "No issues" over a blocker that is still open and still
 * being fed back to the agent.
 */
function badgeStanding(
  data: BadgeData,
): { kind: Standing; label: string; tone: string; repeatCount: number } | null {
  if (data.lifecycle === "waiting") {
    return {
      kind: "waiting",
      label: SEVERITY_HINT.waiting,
      tone: TONE_DASHED,
      repeatCount: 0,
    };
  }
  if (data.lifecycle === "pending" || data.reviewing) {
    return {
      kind: "reviewing",
      label: SEVERITY_HINT.reviewing,
      tone: TONE_DASHED,
      repeatCount: 0,
    };
  }
  if (data.lifecycle === "decided") {
    return {
      kind: "decided",
      label: SEVERITY_HINT.decided,
      tone: TONE_NEUTRAL,
      repeatCount: 0,
    };
  }
  if (data.latestIsUnavailable) {
    return {
      kind: "unavailable",
      label: `Advisor did not run: ${data.latestUnavailableReason ?? "the review failed"}. This is not an approval.`,
      tone: TONE_DASHED,
      repeatCount: 0,
    };
  }
  const open = data.open;
  if (open) {
    const repeated =
      open.repeatCount > 1
        ? ` Flagged ${open.repeatCount} times and still unresolved.`
        : "";
    return {
      kind: open.severity,
      label: `Advisor: ${SEVERITY_LABEL[open.severity]}. ${open.summary}${repeated} ${SEVERITY_HINT[open.severity]}`,
      tone: open.severity === "blocker" ? TONE_ALARM : TONE_NEUTRAL,
      repeatCount: open.repeatCount,
    };
  }
  const latest = data.latest;
  if (!latest) return null;
  return {
    kind: latest.severity,
    label: `Advisor: ${SEVERITY_LABEL[latest.severity]}. ${latest.summary} ${SEVERITY_HINT[latest.severity]}`,
    tone: latest.severity === "blocker" ? TONE_ALARM : TONE_NEUTRAL,
    repeatCount: latest.repeatCount,
  };
}

/**
 * The fix for the plugin's biggest blind spot: a post-turn finding is injected
 * into the next turn's instructions, so without this banner the agent changes
 * course and the human is never told why.
 */
function AdvisorComposerBanner() {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const rpc = useRpc<Contract>();
  const scope = composer.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const { data, error, reload } = useThreadAdvisor<"pendingAdvice">(
    threadId,
    "pendingAdvice",
  );
  const [dismissing, setDismissing] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  if (!threadId) return null;

  // A failed fetch must not look like "no advice": the advice is still injected
  // into the next turn either way, which is the blind spot this banner exists
  // to close.
  const problem = dismissError ?? error;
  if (problem) {
    return (
      <div className="rounded-lg border border-border bg-card px-4 py-3 text-xs">
        <p className="text-destructive-text">
          Advisor status unavailable — any pending review will still be sent to
          the agent. ({problem})
        </p>
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => {
              setDismissError(null);
              void reload();
            }}
            className="h-7 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:bg-state-hover"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const advice = (data as PendingAdviceData | null)?.advice ?? null;
  if (!advice) return null;

  const repeated = advice.repeatCount > 1;

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityChip severity={advice.severity}>
          {repeated
            ? `${SEVERITY_LABEL[advice.severity]} · ${advice.repeatCount}×`
            : SEVERITY_LABEL[advice.severity]}
        </SeverityChip>
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
          Advisor reviewed your last turn
        </h3>
      </div>
      <p className="mt-2">
        <span className="font-medium text-foreground">{advice.summary}</span>
        {repeated ? (
          <span className="text-destructive-text">
            {" "}
            The agent was told this before and did not resolve it.
          </span>
        ) : null}
      </p>
      <p className="mt-1 text-2xs text-subtle-foreground">
        Start a corrective turn now, or it will be shared with the agent on
        your next message.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          disabled={dismissing}
          onClick={() => {
            setDismissing(true);
            setDismissError(null);
            // Dismiss the exact advice on screen. The server refuses if newer
            // advice has since arrived, so a stale click cannot discard a
            // finding that was never shown.
            void rpc
              .call("dismissAdvice", { threadId, adviceId: advice.id })
              .then(reload)
              .catch((caught: unknown) => {
                setDismissError(
                  caught instanceof Error ? caught.message : String(caught),
                );
              })
              .finally(() => setDismissing(false));
          }}
          className="h-7 rounded-md border border-transparent px-2.5 text-xs text-muted-foreground hover:bg-state-hover disabled:opacity-50"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID })}
          className="h-7 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:bg-state-hover"
        >
          View review
        </button>
        <button
          type="button"
          disabled={continuing}
          onClick={() => {
            setContinuing(true);
            setDismissError(null);
            void rpc
              .call("continueFinding", { threadId, reviewId: advice.id })
              .then((result) => {
                if (!result.started && result.reason !== "already-started") {
                  throw new Error("This finding is no longer open.");
                }
                return reload();
              })
              .catch((caught: unknown) => {
                setDismissError(
                  caught instanceof Error ? caught.message : String(caught),
                );
              })
              .finally(() => setContinuing(false));
          }}
          className="h-7 rounded-md border border-surface-destructive-border bg-surface-destructive px-2.5 text-xs font-medium text-destructive-text hover:opacity-90 disabled:opacity-50"
        >
          {continuing ? "Starting…" : "Fix in new turn"}
        </button>
      </div>
    </div>
  );
}

const SUBTLE_BUTTON =
  "h-7 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:bg-state-hover disabled:cursor-not-allowed disabled:opacity-50";

function ReviewRow({
  threadId,
  review,
  expanded,
  now,
  onToggle,
  onResolved,
}: {
  threadId: string;
  review: PanelReview;
  expanded: boolean;
  now: number;
  onToggle: () => void;
  onResolved: () => void;
}) {
  const rpc = useRpc<Contract>();
  const [showWork, setShowWork] = useState(false);
  const [reviewerAvailable, setReviewerAvailable] = useState<boolean | null>(
    null,
  );
  const [reason, setReason] = useState("");
  const [resolving, setResolving] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // The thread that produced THIS review, not whichever reviewer is current:
  // the session pointer moves when the reviewer is respawned.
  const advisorThreadId = review.advisorThreadId;
  const repeated = review.repeatCount > 1;
  // Settled from either direction: the user decided it, or the advisor
  // re-checked and closed it.
  const settled = review.resolvedAt !== null || review.closedAt !== null;
  const lifecycle = lifecycleOf(review, now);

  const openWork = useCallback(() => {
    setShowWork((value) => !value);
    if (reviewerAvailable !== null || !advisorThreadId) return;
    void rpc
      .call("reviewerThreadAvailable", { threadId, advisorThreadId })
      .then((result) => setReviewerAvailable(result.available))
      .catch(() => setReviewerAvailable(false));
  }, [rpc, threadId, advisorThreadId, reviewerAvailable]);

  const setResolved = useCallback(
    (next: boolean, decision: "not-an-issue" | "wont-fix") => {
      setResolving(true);
      setResolveError(null);
      void rpc
        .call("resolveFinding", {
          threadId,
          chainId: review.chainId,
          resolved: next,
          reason: next ? reason.trim() : "",
          decision,
        })
        .then(() => {
          setReason("");
          onResolved();
        })
        .catch((caught: unknown) => {
          setResolveError(
            caught instanceof Error ? caught.message : String(caught),
          );
        })
        .finally(() => setResolving(false));
    },
    [rpc, threadId, review.chainId, reason, onResolved],
  );

  const continueFinding = useCallback(() => {
    setContinuing(true);
    setResolveError(null);
    void rpc
      .call("continueFinding", { threadId, reviewId: review.id })
      .then((result) => {
        if (!result.started && result.reason !== "already-started") {
          throw new Error("This finding is no longer open.");
        }
        onResolved();
      })
      .catch((caught: unknown) => {
        setResolveError(
          caught instanceof Error ? caught.message : String(caught),
        );
      })
      .finally(() => setContinuing(false));
  }, [rpc, threadId, review.id, onResolved]);

  return (
    <div
      className={`border-b border-border last:border-b-0 ${expanded ? "bg-surface-recessed" : ""}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`relative w-full px-3.5 py-3 text-left hover:bg-state-hover ${repeated && !settled ? "pl-5" : ""}`}
      >
        {repeated && !settled ? (
          <span
            aria-hidden="true"
            className="absolute inset-y-1.5 left-0 w-0.5 rounded-sm bg-destructive/60"
          />
        ) : null}
        <span className="flex flex-wrap items-center gap-2">
          <SeverityChip severity={review.severity} muted={settled} />
          <span
            className={`min-w-0 text-sm font-medium ${settled ? "text-muted-foreground line-through decoration-1" : "text-foreground"}`}
          >
            {review.summary}
          </span>
          {repeated ? (
            <span
              title={`Raised ${review.repeatCount} times`}
              className={`${CHIP_BASE} border-border bg-surface-recessed normal-case text-muted-foreground`}
            >
              {review.repeatCount}×
            </span>
          ) : null}
        </span>
        <span className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1 text-2xs text-subtle-foreground">
          {/* What actually happened to this finding. */}
          <span className={lifecycle.tone} title={review.resolvedReason || undefined}>
            {lifecycle.text}
          </span>
          <span aria-hidden="true">·</span>
          {repeated ? (
            <span title={`First raised at timeline sequence ${review.firstSourceSeq}`}>
              first flagged {formatWhen(review.firstCreatedAt, now)}
            </span>
          ) : (
            <span title={`Timeline sequence ${review.sourceSeq}`}>
              {formatWhen(review.createdAt, now)}
            </span>
          )}
          {/* Reviews recorded before provenance was tracked carry no model. */}
          {review.model ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {review.model}
                {review.reasoningLevel && review.reasoningLevel !== "default"
                  ? ` · ${review.reasoningLevel}`
                  : ""}
              </span>
            </>
          ) : null}
        </span>
      </button>

      {expanded ? (
        <div className="px-3.5 pb-3">
          {review.details.trim().length > 0 ? (
            <div className="text-xs text-muted-foreground">
              <Markdown content={review.details} />
            </div>
          ) : (
            <p className="text-xs text-subtle-foreground">
              No further detail was given.
            </p>
          )}
          {review.resolvedAt !== null && review.resolvedReason ? (
            <p className="mt-2 text-2xs text-subtle-foreground">
              Your note: {review.resolvedReason}
            </p>
          ) : null}

          {/* The override. Repeats can only ever escalate on their own, so
              without this a wrong finding is permanent and keeps re-entering
              the agent's instructions. */}
          {review.severity !== "pass" ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {settled ? (
                <button
                  type="button"
                  disabled={resolving}
                  onClick={() => setResolved(false, "not-an-issue")}
                  className={SUBTLE_BUTTON}
                >
                  Reopen
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={continuing || review.continuedAt !== null}
                    onClick={continueFinding}
                    className="h-7 rounded-md border border-surface-destructive-border bg-surface-destructive px-2.5 text-xs font-medium text-destructive-text hover:opacity-90 disabled:opacity-50"
                  >
                    {review.continuedAt !== null
                      ? "Follow-up started"
                      : continuing
                        ? "Starting…"
                        : "Fix in new turn"}
                  </button>
                  <input
                    value={reason}
                    onChange={(event) => setReason(event.currentTarget.value)}
                    maxLength={500}
                    placeholder="Note (optional)"
                    aria-label={`Note about ${review.summary}`}
                    className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground placeholder:text-subtle-foreground"
                  />
                  {/* A user can overrule a finding, but cannot declare it
                      fixed. Only a later Advisor review can verify closure. */}
                  {(
                    [
                      ["not-an-issue", "Not an issue"],
                      ["wont-fix", "Won't fix"],
                    ] as const
                  ).map(([decision, label]) => (
                    <button
                      key={decision}
                      type="button"
                      disabled={resolving}
                      onClick={() => setResolved(true, decision)}
                      className={SUBTLE_BUTTON}
                    >
                      {label}
                    </button>
                  ))}
                </>
              )}
            </div>
          ) : null}
          {resolveError ? (
            <p className="mt-1.5 text-2xs text-destructive-text">
              {resolveError}
            </p>
          ) : null}

          {advisorThreadId ? (
            <>
              <button
                type="button"
                onClick={openWork}
                aria-expanded={showWork}
                className={`mt-2 ${SUBTLE_BUTTON}`}
              >
                {showWork ? "Hide the reviewer's work" : "Show the reviewer's work"}
              </button>
              {showWork ? (
                reviewerAvailable === false ? (
                  <p className="mt-2 text-2xs text-subtle-foreground">
                    The reviewer thread for this review is no longer available.
                  </p>
                ) : reviewerAvailable === null ? (
                  <p className="mt-2 text-2xs text-subtle-foreground">
                    Loading the reviewer&apos;s work…
                  </p>
                ) : (
                  <div className="mt-2 overflow-hidden rounded-lg border border-border">
                    {/* variant="timeline" renders no composer on purpose:
                        chatting with the reviewer would pollute the context
                        that makes repeat detection meaningful. layout
                        "document" grows with content and defers scrolling to
                        the panel, so the transcript is a flowing excerpt rather
                        than a nested scroll region that traps the wheel. */}
                    <ThreadChat
                      threadId={advisorThreadId}
                      variant="timeline"
                      layout="document"
                    />
                  </div>
                )
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function IncidentRow({
  incident,
  now,
}: {
  incident: PanelIncident;
  now: number;
}) {
  return (
    <div className="border-b border-border px-3.5 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <UnavailableChip />
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          {incident.reason}
        </span>
      </div>
      <p className="mt-1 text-2xs text-subtle-foreground">
        No review ran {formatWhen(incident.createdAt, now)} — nothing was
        checked, so this is not an approval.
      </p>
    </div>
  );
}

function AdvisorPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<Contract>();
  const { data, error, reload } = useThreadAdvisor<"threadReviews">(
    threadId,
    "threadReviews",
  );
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const now = useNow();

  // A pass is a clean turn, not a finding, and a chain the user marked "not an
  // issue" is settled. Only what is genuinely outstanding belongs up top.
  const open = useMemo(
    () =>
      (data?.reviews ?? [])
        .filter(
          (review) =>
            review.severity !== "pass" &&
            review.resolvedAt === null &&
            review.closedAt === null,
        )
        .sort(
          (left, right) =>
            SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
            right.sourceSeq - left.sourceSeq ||
            right.id - left.id,
        ),
    [data?.reviews],
  );

  // Findings that were settled, and by whom. This is the audit trail: every
  // row here carries a recorded outcome rather than an inference.
  const decided = useMemo(
    () =>
      (data?.reviews ?? [])
        .filter(
          (review) =>
            review.severity !== "pass" &&
            (review.resolvedAt !== null || review.closedAt !== null),
        )
        .sort(
          (left, right) =>
            (right.resolvedAt ?? right.closedAt ?? 0) -
            (left.resolvedAt ?? left.closedAt ?? 0),
        ),
    [data?.reviews],
  );

  // Clean turns and reviews that never ran, interleaved by the turn they
  // concern so an old failure cannot outrank newer reviews.
  const log = useMemo(() => {
    if (!data) return [];
    const merged: (
      | { kind: "review"; sortSeq: number; review: PanelReview }
      | { kind: "incident"; sortSeq: number; incident: PanelIncident }
    )[] = [
      ...data.reviews
        .filter((review) => review.severity === "pass")
        .map((review) => ({
          kind: "review" as const,
          sortSeq: review.sourceSeq,
          review,
        })),
      ...data.incidents.map((incident) => ({
        kind: "incident" as const,
        sortSeq: incident.sourceSeq,
        incident,
      })),
    ];
    return merged.sort(
      (left, right) =>
        right.sortSeq - left.sortSeq || right.kind.localeCompare(left.kind),
    );
  }, [data]);

  const requestReview = useCallback(() => {
    setRequesting(true);
    setNotice(null);
    void rpc
      .call("requestReview", { threadId })
      .then((result) => {
        if (result.waiting) {
          setNotice("Advisor will review when this agent turn completes.");
        } else if (!result.started) {
          // Not an error: someone (or the post-turn pass) already has one going.
          setNotice("A review is already running.");
        }
        return reload();
      })
      .catch((caught: unknown) => {
        setNotice(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setRequesting(false));
  }, [rpc, threadId, reload]);

  if (error) {
    return (
      <div className="p-4">
        <p className="text-xs text-destructive-text">{error}</p>
        <button
          type="button"
          onClick={() => void reload()}
          className={`mt-2 ${SUBTLE_BUTTON}`}
        >
          Retry
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <p className="p-4 text-xs text-subtle-foreground">Loading reviews…</p>
    );
  }

  const reviewing = data.reviewing;
  const waiting = data.lifecycle === "waiting";
  const everything = data.reviews.length + data.incidents.length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {/* Orientation plus the one control that makes the advisor something the
          user consults rather than something that only happens to them. */}
      <div className="sticky top-0 z-10 border-b border-border bg-background px-3.5 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle-foreground">
          <span className="font-medium text-muted-foreground">
            {open.length === 1 ? "1 open" : `${open.length} open`}
          </span>
          <span aria-hidden="true">·</span>
          <span>{REVIEW_LIFECYCLE_LABEL[data.lifecycle]}</span>
          {decided.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{decided.length} decided</span>
            </>
          ) : null}
          {data.incidents.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {data.incidents.length === 1
                  ? "1 review never ran"
                  : `${data.incidents.length} reviews never ran`}
              </span>
            </>
          ) : null}
          <span className="flex-1" />
          <button
            type="button"
            disabled={reviewing || waiting || requesting}
            onClick={requestReview}
            className={SUBTLE_BUTTON}
          >
            {waiting ? "Waiting…" : reviewing ? "Reviewing…" : "Review now"}
          </button>
        </div>
        {notice ? (
          <p className="mt-1 text-2xs text-subtle-foreground">{notice}</p>
        ) : null}
      </div>

      {open.length === 0 ? (
        <p className="px-3.5 py-6 text-center text-xs text-subtle-foreground">
          {everything === 0
            ? "No advisor reviews on this thread yet."
            : "Nothing outstanding. Earlier reviews are in the log below."}
        </p>
      ) : (
        open.map((review) => (
          // Keyed by the chain, not the round: a new repeat round must not
          // remount the row and close the details the user is reading.
          <ReviewRow
            key={`r${review.chainId}`}
            threadId={threadId}
            review={review}
            now={now}
            expanded={expandedId === review.chainId}
            onToggle={() =>
              setExpandedId((current) =>
                current === review.chainId ? null : review.chainId,
              )
            }
            onResolved={() => void reload()}
          />
        ))
      )}

      {decided.length > 0 ? (
        <details className="border-t border-border" open={open.length === 0}>
          <summary className="cursor-pointer px-3.5 py-2 text-2xs text-subtle-foreground hover:bg-state-hover">
            Decided ({decided.length})
          </summary>
          {decided.map((review) => (
            <ReviewRow
              key={`d${review.chainId}`}
              threadId={threadId}
              review={review}
              now={now}
              expanded={expandedId === review.chainId}
              onToggle={() =>
                setExpandedId((current) =>
                  current === review.chainId ? null : review.chainId,
                )
              }
              onResolved={() => void reload()}
            />
          ))}
        </details>
      ) : null}

      {log.length > 0 ? (
        <details className="border-t border-border">
          <summary className="cursor-pointer px-3.5 py-2 text-2xs text-subtle-foreground hover:bg-state-hover">
            Review log ({log.length})
          </summary>
          {log.map((entry) =>
            entry.kind === "review" ? (
              <ReviewRow
                key={`r${entry.review.chainId}`}
                threadId={threadId}
                review={entry.review}
                now={now}
                expanded={expandedId === entry.review.chainId}
                onToggle={() =>
                  setExpandedId((current) =>
                    current === entry.review.chainId
                      ? null
                      : entry.review.chainId,
                  )
                }
                onResolved={() => void reload()}
              />
            ) : (
              <IncidentRow
                key={`i${entry.incident.id}`}
                incident={entry.incident}
                now={now}
              />
            ),
          )}
        </details>
      ) : null}
    </div>
  );
}

function AdvisorModelSettings() {
  const rpc = useRpc<Contract>();
  const [configuration, setConfiguration] =
    useState<ModelConfiguration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingHostId, setSavingHostId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setConfiguration(await rpc.call("modelConfiguration", null));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!configuration) {
    return <p className="text-sm text-muted-foreground">Loading machine models…</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Each review runs on the primary thread&apos;s machine. Choose an advisor
        model and reasoning level independently for each machine; machines
        without a selection follow the primary thread&apos;s provider and model.
      </p>
      {configuration.hosts.map((host) => {
        const selectedIndex = host.selection
          ? host.options.findIndex(
              (option) =>
                option.providerId === host.selection?.providerId &&
                option.model === host.selection.model,
            )
          : -1;
        const selectedOption =
          selectedIndex >= 0 ? host.options[selectedIndex] : undefined;
        const reasoningAvailable =
          !host.selection ||
          host.selection.reasoningLevel === "default" ||
          selectedOption?.supportedReasoningLevels.includes(
            host.selection.reasoningLevel,
          ) === true;
        const value = selectedIndex >= 0 ? String(selectedIndex) : "follow";
        const saveSelection = (
          selection: (typeof host)["selection"],
        ) => {
          setSavingHostId(host.hostId);
          void rpc
            .call("setHostModel", { hostId: host.hostId, selection })
            .then(load)
            .catch((caught) => {
              setError(caught instanceof Error ? caught.message : String(caught));
            })
            .finally(() => setSavingHostId(null));
        };
        return (
          <div key={host.hostId} className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-foreground">
                  {host.hostName}
                </div>
                <div className="text-xs text-muted-foreground">
                  {host.connected ? "Connected" : "Disconnected"}
                </div>
              </div>
              {savingHostId === host.hostId ? (
                <span className="text-xs text-muted-foreground">Saving…</span>
              ) : null}
            </div>
            <select
              aria-label={`Advisor model for ${host.hostName}`}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!host.connected || savingHostId !== null}
              value={value}
              onChange={(event) => {
                const next = event.currentTarget.value;
                const selection =
                  next === "follow"
                    ? null
                    : (() => {
                        const option = host.options[Number(next)];
                        return option
                          ? {
                              providerId: option.providerId,
                              model: option.model,
                              reasoningLevel: "default" as const,
                            }
                          : null;
                      })();
                saveSelection(selection);
              }}
            >
              <option value="follow">Follow primary thread</option>
              {host.options.map((option, index) => (
                <option
                  key={`${option.providerId}:${option.model}`}
                  value={String(index)}
                >
                  {option.providerName} · {option.modelName}
                  {option.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
            {host.selection && selectedOption ? (
              <select
                aria-label={`Advisor reasoning for ${host.hostName}`}
                className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!host.connected || savingHostId !== null}
                value={host.selection.reasoningLevel}
                onChange={(event) =>
                  saveSelection({
                    providerId: host.selection!.providerId,
                    model: host.selection!.model,
                    reasoningLevel: event.currentTarget.value as (
                      typeof host.selection
                    )["reasoningLevel"],
                  })
                }
              >
                <option value="default">
                  Model default ({selectedOption.defaultReasoningLevel})
                </option>
                {selectedOption.supportedReasoningLevels.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            ) : null}
            {host.selection && (selectedIndex < 0 || !reasoningAvailable) ? (
              <p className="mt-2 text-xs text-destructive">
                Saved configuration {host.selection.providerId}/
                {host.selection.model}@{host.selection.reasoningLevel} is
                unavailable. Reviews currently follow the primary model.
              </p>
            ) : null}
            {host.error ? (
              <p className="mt-2 text-xs text-muted-foreground">{host.error}</p>
            ) : null}
          </div>
        );
      })}
      {configuration.hosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No enrolled machines found.</p>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "models",
    title: "Advisor model by machine",
    description: "Live model choices from each enrolled bb machine.",
    component: AdvisorModelSettings,
  });

  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Advisor",
    icon: "ShieldCheck",
    layout: "flush",
    component: AdvisorPanel,
  });

  app.slots.experimental_threadHeaderAction({
    id: "verdict",
    title: "Advisor verdict",
    component: AdvisorHeaderBadge,
  });

  app.composer.customize({
    id: "pending-advice",
    scopes: ["thread"],
    banners: [{ id: "pending-advice", chrome: "bare", component: AdvisorComposerBanner }],
  });
});
