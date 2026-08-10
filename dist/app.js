// bb-plugin-runtime-shim:react
var runtime = globalThis.__bbPluginRuntime;
if (runtime == null || runtime.react == null) {
  throw new Error('Cannot load "react": this bundle must be loaded by the BB app, which provides the shared plugin runtime (globalThis.__bbPluginRuntime).');
}
var mod = runtime.react;
var {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  act,
  cache,
  cacheSignal,
  captureOwnerStack,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  unstable_useCacheRefresh,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version
} = mod;

// bb-plugin-runtime-shim:@bb/plugin-sdk/app
var runtime2 = globalThis.__bbPluginRuntime;
if (runtime2 == null || runtime2.pluginSdkApp == null) {
  throw new Error('Cannot load "@bb/plugin-sdk/app": this bundle must be loaded by the BB app, which provides the shared plugin runtime (globalThis.__bbPluginRuntime).');
}
var mod2 = runtime2.pluginSdkApp;
var {
  Markdown,
  ThreadChat,
  definePluginApp,
  experimental_NewThreadComposer,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit,
  experimental_useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useComposer,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings
} = mod2;

// bb-plugin-runtime-shim:react/jsx-runtime
var runtime3 = globalThis.__bbPluginRuntime;
if (runtime3 == null || runtime3.jsxRuntime == null) {
  throw new Error('Cannot load "react/jsx-runtime": this bundle must be loaded by the BB app, which provides the shared plugin runtime (globalThis.__bbPluginRuntime).');
}
var mod3 = runtime3.jsxRuntime;
var {
  Fragment: Fragment2,
  jsx,
  jsxs
} = mod3;

// app.tsx
var PANEL_ACTION_ID = "reviews";
var REVIEW_LIFECYCLE_LABEL = {
  unreviewed: "Not reviewed",
  waiting: "Waiting for completed turn",
  pending: "Review pending",
  approved: "Approved",
  "changes-requested": "Changes requested",
  decided: "User decided",
  unavailable: "Review unavailable"
};
var DECISION_LABEL = {
  fixed: "You marked it fixed",
  "not-an-issue": "You said it isn't an issue",
  "wont-fix": "You decided not to fix it"
};
function lifecycleOf(review, now) {
  if (review.resolvedAt !== null) {
    return {
      text: `${review.decision === "" ? "You dismissed it" : DECISION_LABEL[review.decision]} ${formatWhen(review.resolvedAt, now)}`,
      tone: "text-subtle-foreground"
    };
  }
  if (review.closedAt !== null) {
    return {
      text: `Advisor re-checked and closed it${review.closedSeq === null ? "" : ` at turn ${review.closedSeq}`}`,
      tone: "text-success-foreground"
    };
  }
  if (review.continuedAt !== null) {
    return {
      text: `Corrective follow-up started ${formatWhen(review.continuedAt, now)}`,
      tone: "text-subtle-foreground"
    };
  }
  if (review.repeatCount > 1) {
    return {
      text: `Re-raised ${review.repeatCount}\xD7 \u2014 not addressed`,
      tone: "text-destructive-text"
    };
  }
  if (review.sentAt !== null) {
    return {
      text: `Sent to the agent ${formatWhen(review.sentAt, now)}`,
      tone: "text-subtle-foreground"
    };
  }
  return {
    text: "Queued \u2014 goes to the agent with your next message",
    tone: "text-subtle-foreground"
  };
}
var SEVERITY_RANK = {
  pass: 0,
  nit: 1,
  concern: 2,
  blocker: 3
};
var SEVERITY_STYLE = {
  blocker: "text-destructive-text border-surface-destructive-border bg-surface-destructive",
  concern: "text-warning-text border-warning/30 bg-warning/10",
  nit: "text-readback-foreground border-border bg-surface-recessed",
  pass: "text-success-foreground border-success/30 bg-success/10"
};
var CHIP_BASE = "inline-flex items-center gap-1.5 rounded-full border px-1.5 py-px text-2xs font-semibold uppercase tracking-wide whitespace-nowrap";
var SEVERITY_LABEL = {
  blocker: "Must fix",
  concern: "Should fix",
  nit: "Minor",
  pass: "No issues",
  unavailable: "Didn't run",
  reviewing: "Review pending",
  waiting: "Waiting",
  decided: "Decided"
};
var SEVERITY_HINT = {
  blocker: "The advisor found something it thinks must be fixed before this work is finished.",
  concern: "The advisor found a real problem worth fixing, but not a blocking one.",
  nit: "A small suggestion. Safe to ignore.",
  pass: "The advisor reviewed this turn and found nothing actionable.",
  unavailable: "The review did not run, so nothing was checked. This is not an approval.",
  reviewing: "A review is running right now. Nothing has been checked yet.",
  waiting: "Advisor will review when the current agent turn has a completed answer.",
  decided: "The user overruled or accepted the latest finding. Advisor did not verify a fix."
};
function formatWhen(epochMs, now) {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1e3));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}
function useNow(intervalMs = 6e4) {
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
  children
}) {
  return /* @__PURE__ */ jsxs(
    "span",
    {
      title: SEVERITY_HINT[severity],
      className: `${CHIP_BASE} ${SEVERITY_STYLE[severity]} ${muted ? "opacity-60" : ""}`,
      children: [
        /* @__PURE__ */ jsx("span", { className: "size-1.5 shrink-0 rounded-full bg-current" }),
        children ?? SEVERITY_LABEL[severity]
      ]
    }
  );
}
function UnavailableChip({ children }) {
  return /* @__PURE__ */ jsxs(
    "span",
    {
      title: SEVERITY_HINT.unavailable,
      className: `${CHIP_BASE} border-dashed border-border bg-transparent text-subtle-foreground`,
      children: [
        /* @__PURE__ */ jsx("span", { className: "size-1.5 shrink-0 rounded-full bg-current" }),
        children ?? SEVERITY_LABEL.unavailable
      ]
    }
  );
}
var SEVERITY_GLYPH = {
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
  decided: "M5 12l4 4L19 6M12 3a9 9 0 1 0 0 18"
};
function SeverityGlyph({
  standing,
  className
}) {
  return /* @__PURE__ */ jsx(
    "svg",
    {
      className,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      children: /* @__PURE__ */ jsx("path", { d: SEVERITY_GLYPH[standing] })
    }
  );
}
function useThreadAdvisor(threadId, method) {
  const rpc = useRpc();
  const [data, setData] = useState(
    null
  );
  const [error, setError] = useState(null);
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
      (payload) => {
        const target = typeof payload === "object" && payload !== null ? payload.threadId : void 0;
        if (target === threadId) void load();
      },
      [threadId, load]
    )
  );
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
  isCompactViewport
}) {
  const navigate = useBbNavigate();
  const { data } = useThreadAdvisor(threadId, "threadBadge");
  if (!data) return null;
  const standing = badgeStanding(data);
  if (!standing) return null;
  return /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      title: standing.label,
      "aria-label": standing.label,
      onClick: () => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID }),
      className: `inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs hover:bg-state-hover ${standing.tone}`,
      children: [
        /* @__PURE__ */ jsx(SeverityGlyph, { standing: standing.kind, className: "size-3.5 shrink-0" }),
        isCompactViewport ? null : /* @__PURE__ */ jsx("span", { children: SEVERITY_LABEL[standing.kind] }),
        standing.repeatCount > 1 ? /* @__PURE__ */ jsxs("span", { className: "text-2xs font-semibold tabular-nums opacity-85", children: [
          "\xD7",
          standing.repeatCount
        ] }) : null
      ]
    }
  );
}
var TONE_NEUTRAL = "text-muted-foreground border-border bg-surface-recessed";
var TONE_DASHED = "border-dashed border-border bg-transparent text-subtle-foreground";
var TONE_ALARM = "text-destructive-text border-surface-destructive-border bg-surface-destructive";
function badgeStanding(data) {
  if (data.lifecycle === "waiting") {
    return {
      kind: "waiting",
      label: SEVERITY_HINT.waiting,
      tone: TONE_DASHED,
      repeatCount: 0
    };
  }
  if (data.lifecycle === "pending" || data.reviewing) {
    return {
      kind: "reviewing",
      label: SEVERITY_HINT.reviewing,
      tone: TONE_DASHED,
      repeatCount: 0
    };
  }
  if (data.lifecycle === "decided") {
    return {
      kind: "decided",
      label: SEVERITY_HINT.decided,
      tone: TONE_NEUTRAL,
      repeatCount: 0
    };
  }
  if (data.latestIsUnavailable) {
    return {
      kind: "unavailable",
      label: `Advisor did not run: ${data.latestUnavailableReason ?? "the review failed"}. This is not an approval.`,
      tone: TONE_DASHED,
      repeatCount: 0
    };
  }
  const open = data.open;
  if (open) {
    const repeated = open.repeatCount > 1 ? ` Flagged ${open.repeatCount} times and still unresolved.` : "";
    return {
      kind: open.severity,
      label: `Advisor: ${SEVERITY_LABEL[open.severity]}. ${open.summary}${repeated} ${SEVERITY_HINT[open.severity]}`,
      tone: open.severity === "blocker" ? TONE_ALARM : TONE_NEUTRAL,
      repeatCount: open.repeatCount
    };
  }
  const latest = data.latest;
  if (!latest) return null;
  return {
    kind: latest.severity,
    label: `Advisor: ${SEVERITY_LABEL[latest.severity]}. ${latest.summary} ${SEVERITY_HINT[latest.severity]}`,
    tone: latest.severity === "blocker" ? TONE_ALARM : TONE_NEUTRAL,
    repeatCount: latest.repeatCount
  };
}
function AdvisorComposerBanner() {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const rpc = useRpc();
  const scope = composer.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const { data, error, reload } = useThreadAdvisor(
    threadId,
    "pendingAdvice"
  );
  const [dismissing, setDismissing] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [dismissError, setDismissError] = useState(null);
  if (!threadId) return null;
  const problem = dismissError ?? error;
  if (problem) {
    return /* @__PURE__ */ jsxs("div", { className: "rounded-lg border border-border bg-card px-4 py-3 text-xs", children: [
      /* @__PURE__ */ jsxs("p", { className: "text-destructive-text", children: [
        "Advisor status unavailable \u2014 any pending review will still be sent to the agent. (",
        problem,
        ")"
      ] }),
      /* @__PURE__ */ jsx("div", { className: "mt-2 flex justify-end", children: /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: () => {
            setDismissError(null);
            void reload();
          },
          className: "h-7 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:bg-state-hover",
          children: "Retry"
        }
      ) })
    ] });
  }
  const advice = data?.advice ?? null;
  if (!advice) return null;
  const repeated = advice.repeatCount > 1;
  return /* @__PURE__ */ jsxs("div", { className: "rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [
      /* @__PURE__ */ jsx(SeverityChip, { severity: advice.severity, children: repeated ? `${SEVERITY_LABEL[advice.severity]} \xB7 ${advice.repeatCount}\xD7` : SEVERITY_LABEL[advice.severity] }),
      /* @__PURE__ */ jsx("h3", { className: "min-w-0 flex-1 text-sm font-semibold text-foreground", children: "Advisor reviewed your last turn" })
    ] }),
    /* @__PURE__ */ jsxs("p", { className: "mt-2", children: [
      /* @__PURE__ */ jsx("span", { className: "font-medium text-foreground", children: advice.summary }),
      repeated ? /* @__PURE__ */ jsxs("span", { className: "text-destructive-text", children: [
        " ",
        "The agent was told this before and did not resolve it."
      ] }) : null
    ] }),
    /* @__PURE__ */ jsx("p", { className: "mt-1 text-2xs text-subtle-foreground", children: "Start a corrective turn now, or it will be shared with the agent on your next message." }),
    /* @__PURE__ */ jsxs("div", { className: "mt-3 flex flex-wrap items-center justify-end gap-2", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          disabled: dismissing,
          onClick: () => {
            setDismissing(true);
            setDismissError(null);
            void rpc.call("dismissAdvice", { threadId, adviceId: advice.id }).then(reload).catch((caught) => {
              setDismissError(
                caught instanceof Error ? caught.message : String(caught)
              );
            }).finally(() => setDismissing(false));
          },
          className: "h-7 rounded-md border border-transparent px-2.5 text-xs text-muted-foreground hover:bg-state-hover disabled:opacity-50",
          children: "Dismiss"
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: () => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID }),
          className: "h-7 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:bg-state-hover",
          children: "View review"
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          disabled: continuing,
          onClick: () => {
            setContinuing(true);
            setDismissError(null);
            void rpc.call("continueFinding", { threadId, reviewId: advice.id }).then((result) => {
              if (!result.started && result.reason !== "already-started") {
                throw new Error("This finding is no longer open.");
              }
              return reload();
            }).catch((caught) => {
              setDismissError(
                caught instanceof Error ? caught.message : String(caught)
              );
            }).finally(() => setContinuing(false));
          },
          className: "h-7 rounded-md border border-surface-destructive-border bg-surface-destructive px-2.5 text-xs font-medium text-destructive-text hover:opacity-90 disabled:opacity-50",
          children: continuing ? "Starting\u2026" : "Fix in new turn"
        }
      )
    ] })
  ] });
}
var SUBTLE_BUTTON = "h-7 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:bg-state-hover disabled:cursor-not-allowed disabled:opacity-50";
function ReviewRow({
  threadId,
  review,
  expanded,
  now,
  onToggle,
  onResolved
}) {
  const rpc = useRpc();
  const [showWork, setShowWork] = useState(false);
  const [reviewerAvailable, setReviewerAvailable] = useState(
    null
  );
  const [reason, setReason] = useState("");
  const [resolving, setResolving] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [resolveError, setResolveError] = useState(null);
  const advisorThreadId = review.advisorThreadId;
  const repeated = review.repeatCount > 1;
  const settled = review.resolvedAt !== null || review.closedAt !== null;
  const lifecycle = lifecycleOf(review, now);
  const openWork = useCallback(() => {
    setShowWork((value) => !value);
    if (reviewerAvailable !== null || !advisorThreadId) return;
    void rpc.call("reviewerThreadAvailable", { threadId, advisorThreadId }).then((result) => setReviewerAvailable(result.available)).catch(() => setReviewerAvailable(false));
  }, [rpc, threadId, advisorThreadId, reviewerAvailable]);
  const setResolved = useCallback(
    (next, decision) => {
      setResolving(true);
      setResolveError(null);
      void rpc.call("resolveFinding", {
        threadId,
        chainId: review.chainId,
        resolved: next,
        reason: next ? reason.trim() : "",
        decision
      }).then(() => {
        setReason("");
        onResolved();
      }).catch((caught) => {
        setResolveError(
          caught instanceof Error ? caught.message : String(caught)
        );
      }).finally(() => setResolving(false));
    },
    [rpc, threadId, review.chainId, reason, onResolved]
  );
  const continueFinding = useCallback(() => {
    setContinuing(true);
    setResolveError(null);
    void rpc.call("continueFinding", { threadId, reviewId: review.id }).then((result) => {
      if (!result.started && result.reason !== "already-started") {
        throw new Error("This finding is no longer open.");
      }
      onResolved();
    }).catch((caught) => {
      setResolveError(
        caught instanceof Error ? caught.message : String(caught)
      );
    }).finally(() => setContinuing(false));
  }, [rpc, threadId, review.id, onResolved]);
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: `border-b border-border last:border-b-0 ${expanded ? "bg-surface-recessed" : ""}`,
      children: [
        /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            onClick: onToggle,
            "aria-expanded": expanded,
            className: `relative w-full px-3.5 py-3 text-left hover:bg-state-hover ${repeated && !settled ? "pl-5" : ""}`,
            children: [
              repeated && !settled ? /* @__PURE__ */ jsx(
                "span",
                {
                  "aria-hidden": "true",
                  className: "absolute inset-y-1.5 left-0 w-0.5 rounded-sm bg-destructive/60"
                }
              ) : null,
              /* @__PURE__ */ jsxs("span", { className: "flex flex-wrap items-center gap-2", children: [
                /* @__PURE__ */ jsx(SeverityChip, { severity: review.severity, muted: settled }),
                /* @__PURE__ */ jsx(
                  "span",
                  {
                    className: `min-w-0 text-sm font-medium ${settled ? "text-muted-foreground line-through decoration-1" : "text-foreground"}`,
                    children: review.summary
                  }
                ),
                repeated ? /* @__PURE__ */ jsxs(
                  "span",
                  {
                    title: `Raised ${review.repeatCount} times`,
                    className: `${CHIP_BASE} border-border bg-surface-recessed normal-case text-muted-foreground`,
                    children: [
                      review.repeatCount,
                      "\xD7"
                    ]
                  }
                ) : null
              ] }),
              /* @__PURE__ */ jsxs("span", { className: "mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1 text-2xs text-subtle-foreground", children: [
                /* @__PURE__ */ jsx("span", { className: lifecycle.tone, title: review.resolvedReason || void 0, children: lifecycle.text }),
                /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
                repeated ? /* @__PURE__ */ jsxs("span", { title: `First raised at timeline sequence ${review.firstSourceSeq}`, children: [
                  "first flagged ",
                  formatWhen(review.firstCreatedAt, now)
                ] }) : /* @__PURE__ */ jsx("span", { title: `Timeline sequence ${review.sourceSeq}`, children: formatWhen(review.createdAt, now) }),
                review.model ? /* @__PURE__ */ jsxs(Fragment2, { children: [
                  /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
                  /* @__PURE__ */ jsxs("span", { children: [
                    review.model,
                    review.reasoningLevel && review.reasoningLevel !== "default" ? ` \xB7 ${review.reasoningLevel}` : ""
                  ] })
                ] }) : null
              ] })
            ]
          }
        ),
        expanded ? /* @__PURE__ */ jsxs("div", { className: "px-3.5 pb-3", children: [
          review.details.trim().length > 0 ? /* @__PURE__ */ jsx("div", { className: "text-xs text-muted-foreground", children: /* @__PURE__ */ jsx(Markdown, { content: review.details }) }) : /* @__PURE__ */ jsx("p", { className: "text-xs text-subtle-foreground", children: "No further detail was given." }),
          review.resolvedAt !== null && review.resolvedReason ? /* @__PURE__ */ jsxs("p", { className: "mt-2 text-2xs text-subtle-foreground", children: [
            "Your note: ",
            review.resolvedReason
          ] }) : null,
          review.severity !== "pass" ? /* @__PURE__ */ jsx("div", { className: "mt-2.5 flex flex-wrap items-center gap-2", children: settled ? /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              disabled: resolving,
              onClick: () => setResolved(false, "not-an-issue"),
              className: SUBTLE_BUTTON,
              children: "Reopen"
            }
          ) : /* @__PURE__ */ jsxs(Fragment2, { children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                disabled: continuing || review.continuedAt !== null,
                onClick: continueFinding,
                className: "h-7 rounded-md border border-surface-destructive-border bg-surface-destructive px-2.5 text-xs font-medium text-destructive-text hover:opacity-90 disabled:opacity-50",
                children: review.continuedAt !== null ? "Follow-up started" : continuing ? "Starting\u2026" : "Fix in new turn"
              }
            ),
            /* @__PURE__ */ jsx(
              "input",
              {
                value: reason,
                onChange: (event) => setReason(event.currentTarget.value),
                maxLength: 500,
                placeholder: "Note (optional)",
                "aria-label": `Note about ${review.summary}`,
                className: "h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground placeholder:text-subtle-foreground"
              }
            ),
            [
              ["not-an-issue", "Not an issue"],
              ["wont-fix", "Won't fix"]
            ].map(([decision, label]) => /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                disabled: resolving,
                onClick: () => setResolved(true, decision),
                className: SUBTLE_BUTTON,
                children: label
              },
              decision
            ))
          ] }) }) : null,
          resolveError ? /* @__PURE__ */ jsx("p", { className: "mt-1.5 text-2xs text-destructive-text", children: resolveError }) : null,
          advisorThreadId ? /* @__PURE__ */ jsxs(Fragment2, { children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: openWork,
                "aria-expanded": showWork,
                className: `mt-2 ${SUBTLE_BUTTON}`,
                children: showWork ? "Hide the reviewer's work" : "Show the reviewer's work"
              }
            ),
            showWork ? reviewerAvailable === false ? /* @__PURE__ */ jsx("p", { className: "mt-2 text-2xs text-subtle-foreground", children: "The reviewer thread for this review is no longer available." }) : reviewerAvailable === null ? /* @__PURE__ */ jsx("p", { className: "mt-2 text-2xs text-subtle-foreground", children: "Loading the reviewer's work\u2026" }) : /* @__PURE__ */ jsx("div", { className: "mt-2 overflow-hidden rounded-lg border border-border", children: /* @__PURE__ */ jsx(
              ThreadChat,
              {
                threadId: advisorThreadId,
                variant: "timeline",
                layout: "document"
              }
            ) }) : null
          ] }) : null
        ] }) : null
      ]
    }
  );
}
function IncidentRow({
  incident,
  now
}) {
  return /* @__PURE__ */ jsxs("div", { className: "border-b border-border px-3.5 py-3 last:border-b-0", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [
      /* @__PURE__ */ jsx(UnavailableChip, {}),
      /* @__PURE__ */ jsx("span", { className: "min-w-0 flex-1 text-xs text-muted-foreground", children: incident.reason })
    ] }),
    /* @__PURE__ */ jsxs("p", { className: "mt-1 text-2xs text-subtle-foreground", children: [
      "No review ran ",
      formatWhen(incident.createdAt, now),
      " \u2014 nothing was checked, so this is not an approval."
    ] })
  ] });
}
function AdvisorPanel({ threadId }) {
  const rpc = useRpc();
  const { data, error, reload } = useThreadAdvisor(
    threadId,
    "threadReviews"
  );
  const [expandedId, setExpandedId] = useState(null);
  const [requesting, setRequesting] = useState(false);
  const [notice, setNotice] = useState(null);
  const now = useNow();
  const open = useMemo(
    () => (data?.reviews ?? []).filter(
      (review) => review.severity !== "pass" && review.resolvedAt === null && review.closedAt === null
    ).sort(
      (left, right) => SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] || right.sourceSeq - left.sourceSeq || right.id - left.id
    ),
    [data?.reviews]
  );
  const decided = useMemo(
    () => (data?.reviews ?? []).filter(
      (review) => review.severity !== "pass" && (review.resolvedAt !== null || review.closedAt !== null)
    ).sort(
      (left, right) => (right.resolvedAt ?? right.closedAt ?? 0) - (left.resolvedAt ?? left.closedAt ?? 0)
    ),
    [data?.reviews]
  );
  const log = useMemo(() => {
    if (!data) return [];
    const merged = [
      ...data.reviews.filter((review) => review.severity === "pass").map((review) => ({
        kind: "review",
        sortSeq: review.sourceSeq,
        review
      })),
      ...data.incidents.map((incident) => ({
        kind: "incident",
        sortSeq: incident.sourceSeq,
        incident
      }))
    ];
    return merged.sort(
      (left, right) => right.sortSeq - left.sortSeq || right.kind.localeCompare(left.kind)
    );
  }, [data]);
  const requestReview = useCallback(() => {
    setRequesting(true);
    setNotice(null);
    void rpc.call("requestReview", { threadId }).then((result) => {
      if (result.waiting) {
        setNotice("Advisor will review when this agent turn completes.");
      } else if (!result.started) {
        setNotice("A review is already running.");
      }
      return reload();
    }).catch((caught) => {
      setNotice(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => setRequesting(false));
  }, [rpc, threadId, reload]);
  if (error) {
    return /* @__PURE__ */ jsxs("div", { className: "p-4", children: [
      /* @__PURE__ */ jsx("p", { className: "text-xs text-destructive-text", children: error }),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: () => void reload(),
          className: `mt-2 ${SUBTLE_BUTTON}`,
          children: "Retry"
        }
      )
    ] });
  }
  if (!data) {
    return /* @__PURE__ */ jsx("p", { className: "p-4 text-xs text-subtle-foreground", children: "Loading reviews\u2026" });
  }
  const reviewing = data.reviewing;
  const waiting = data.lifecycle === "waiting";
  const everything = data.reviews.length + data.incidents.length;
  return /* @__PURE__ */ jsxs("div", { className: "flex h-full min-h-0 flex-col overflow-y-auto", children: [
    /* @__PURE__ */ jsxs("div", { className: "sticky top-0 z-10 border-b border-border bg-background px-3.5 py-2", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle-foreground", children: [
        /* @__PURE__ */ jsx("span", { className: "font-medium text-muted-foreground", children: open.length === 1 ? "1 open" : `${open.length} open` }),
        /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
        /* @__PURE__ */ jsx("span", { children: REVIEW_LIFECYCLE_LABEL[data.lifecycle] }),
        decided.length > 0 ? /* @__PURE__ */ jsxs(Fragment2, { children: [
          /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
          /* @__PURE__ */ jsxs("span", { children: [
            decided.length,
            " decided"
          ] })
        ] }) : null,
        data.incidents.length > 0 ? /* @__PURE__ */ jsxs(Fragment2, { children: [
          /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
          /* @__PURE__ */ jsx("span", { children: data.incidents.length === 1 ? "1 review never ran" : `${data.incidents.length} reviews never ran` })
        ] }) : null,
        /* @__PURE__ */ jsx("span", { className: "flex-1" }),
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            disabled: reviewing || waiting || requesting,
            onClick: requestReview,
            className: SUBTLE_BUTTON,
            children: waiting ? "Waiting\u2026" : reviewing ? "Reviewing\u2026" : "Review now"
          }
        )
      ] }),
      notice ? /* @__PURE__ */ jsx("p", { className: "mt-1 text-2xs text-subtle-foreground", children: notice }) : null
    ] }),
    open.length === 0 ? /* @__PURE__ */ jsx("p", { className: "px-3.5 py-6 text-center text-xs text-subtle-foreground", children: everything === 0 ? "No advisor reviews on this thread yet." : "Nothing outstanding. Earlier reviews are in the log below." }) : open.map((review) => (
      // Keyed by the chain, not the round: a new repeat round must not
      // remount the row and close the details the user is reading.
      /* @__PURE__ */ jsx(
        ReviewRow,
        {
          threadId,
          review,
          now,
          expanded: expandedId === review.chainId,
          onToggle: () => setExpandedId(
            (current) => current === review.chainId ? null : review.chainId
          ),
          onResolved: () => void reload()
        },
        `r${review.chainId}`
      )
    )),
    decided.length > 0 ? /* @__PURE__ */ jsxs("details", { className: "border-t border-border", open: open.length === 0, children: [
      /* @__PURE__ */ jsxs("summary", { className: "cursor-pointer px-3.5 py-2 text-2xs text-subtle-foreground hover:bg-state-hover", children: [
        "Decided (",
        decided.length,
        ")"
      ] }),
      decided.map((review) => /* @__PURE__ */ jsx(
        ReviewRow,
        {
          threadId,
          review,
          now,
          expanded: expandedId === review.chainId,
          onToggle: () => setExpandedId(
            (current) => current === review.chainId ? null : review.chainId
          ),
          onResolved: () => void reload()
        },
        `d${review.chainId}`
      ))
    ] }) : null,
    log.length > 0 ? /* @__PURE__ */ jsxs("details", { className: "border-t border-border", children: [
      /* @__PURE__ */ jsxs("summary", { className: "cursor-pointer px-3.5 py-2 text-2xs text-subtle-foreground hover:bg-state-hover", children: [
        "Review log (",
        log.length,
        ")"
      ] }),
      log.map(
        (entry) => entry.kind === "review" ? /* @__PURE__ */ jsx(
          ReviewRow,
          {
            threadId,
            review: entry.review,
            now,
            expanded: expandedId === entry.review.chainId,
            onToggle: () => setExpandedId(
              (current) => current === entry.review.chainId ? null : entry.review.chainId
            ),
            onResolved: () => void reload()
          },
          `r${entry.review.chainId}`
        ) : /* @__PURE__ */ jsx(
          IncidentRow,
          {
            incident: entry.incident,
            now
          },
          `i${entry.incident.id}`
        )
      )
    ] }) : null
  ] });
}
function AdvisorModelSettings() {
  const rpc = useRpc();
  const [configuration, setConfiguration] = useState(null);
  const [error, setError] = useState(null);
  const [savingHostId, setSavingHostId] = useState(null);
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
    return /* @__PURE__ */ jsx("p", { className: "text-sm text-destructive", children: error });
  }
  if (!configuration) {
    return /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: "Loading machine models\u2026" });
  }
  return /* @__PURE__ */ jsxs("div", { className: "space-y-4", children: [
    /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: "Each review runs on the primary thread's machine. Choose an advisor model and reasoning level independently for each machine; machines without a selection follow the primary thread's provider and model." }),
    configuration.hosts.map((host) => {
      const selectedIndex = host.selection ? host.options.findIndex(
        (option) => option.providerId === host.selection?.providerId && option.model === host.selection.model
      ) : -1;
      const selectedOption = selectedIndex >= 0 ? host.options[selectedIndex] : void 0;
      const reasoningAvailable = !host.selection || host.selection.reasoningLevel === "default" || selectedOption?.supportedReasoningLevels.includes(
        host.selection.reasoningLevel
      ) === true;
      const value = selectedIndex >= 0 ? String(selectedIndex) : "follow";
      const saveSelection = (selection) => {
        setSavingHostId(host.hostId);
        void rpc.call("setHostModel", { hostId: host.hostId, selection }).then(load).catch((caught) => {
          setError(caught instanceof Error ? caught.message : String(caught));
        }).finally(() => setSavingHostId(null));
      };
      return /* @__PURE__ */ jsxs("div", { className: "rounded-lg border border-border p-3", children: [
        /* @__PURE__ */ jsxs("div", { className: "mb-2 flex items-center justify-between gap-3", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { className: "text-sm font-medium text-foreground", children: host.hostName }),
            /* @__PURE__ */ jsx("div", { className: "text-xs text-muted-foreground", children: host.connected ? "Connected" : "Disconnected" })
          ] }),
          savingHostId === host.hostId ? /* @__PURE__ */ jsx("span", { className: "text-xs text-muted-foreground", children: "Saving\u2026" }) : null
        ] }),
        /* @__PURE__ */ jsxs(
          "select",
          {
            "aria-label": `Advisor model for ${host.hostName}`,
            className: "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50",
            disabled: !host.connected || savingHostId !== null,
            value,
            onChange: (event) => {
              const next = event.currentTarget.value;
              const selection = next === "follow" ? null : (() => {
                const option = host.options[Number(next)];
                return option ? {
                  providerId: option.providerId,
                  model: option.model,
                  reasoningLevel: "default"
                } : null;
              })();
              saveSelection(selection);
            },
            children: [
              /* @__PURE__ */ jsx("option", { value: "follow", children: "Follow primary thread" }),
              host.options.map((option, index) => /* @__PURE__ */ jsxs(
                "option",
                {
                  value: String(index),
                  children: [
                    option.providerName,
                    " \xB7 ",
                    option.modelName,
                    option.isDefault ? " (default)" : ""
                  ]
                },
                `${option.providerId}:${option.model}`
              ))
            ]
          }
        ),
        host.selection && selectedOption ? /* @__PURE__ */ jsxs(
          "select",
          {
            "aria-label": `Advisor reasoning for ${host.hostName}`,
            className: "mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50",
            disabled: !host.connected || savingHostId !== null,
            value: host.selection.reasoningLevel,
            onChange: (event) => saveSelection({
              providerId: host.selection.providerId,
              model: host.selection.model,
              reasoningLevel: event.currentTarget.value
            }),
            children: [
              /* @__PURE__ */ jsxs("option", { value: "default", children: [
                "Model default (",
                selectedOption.defaultReasoningLevel,
                ")"
              ] }),
              selectedOption.supportedReasoningLevels.map((level) => /* @__PURE__ */ jsx("option", { value: level, children: level }, level))
            ]
          }
        ) : null,
        host.selection && (selectedIndex < 0 || !reasoningAvailable) ? /* @__PURE__ */ jsxs("p", { className: "mt-2 text-xs text-destructive", children: [
          "Saved configuration ",
          host.selection.providerId,
          "/",
          host.selection.model,
          "@",
          host.selection.reasoningLevel,
          " is unavailable. Reviews currently follow the primary model."
        ] }) : null,
        host.error ? /* @__PURE__ */ jsx("p", { className: "mt-2 text-xs text-muted-foreground", children: host.error }) : null
      ] }, host.hostId);
    }),
    configuration.hosts.length === 0 ? /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: "No enrolled machines found." }) : null
  ] });
}
var app_default = definePluginApp((app) => {
  app.slots.settingsSection({
    id: "models",
    title: "Advisor model by machine",
    description: "Live model choices from each enrolled bb machine.",
    component: AdvisorModelSettings
  });
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Advisor",
    icon: "ShieldCheck",
    layout: "flush",
    component: AdvisorPanel
  });
  app.slots.experimental_threadHeaderAction({
    id: "verdict",
    title: "Advisor verdict",
    component: AdvisorHeaderBadge
  });
  app.composer.customize({
    id: "pending-advice",
    scopes: ["thread"],
    banners: [{ id: "pending-advice", chrome: "bare", component: AdvisorComposerBanner }]
  });
});
export {
  app_default as default
};
