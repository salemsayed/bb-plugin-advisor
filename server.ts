import { z } from "zod";
import { defineRpcContract } from "@bb/plugin-sdk";
import type {
  BbPluginApi,
  PluginAgentConfigurationContext,
} from "@bb/plugin-sdk";
import {
  formatReview,
  formatTimelineRows,
  meetsThreshold,
  normalizeAdvice,
  parseAdvisorOutput,
  strongerSeverity,
  type AdvisorFinding,
  type AdvisorSeverity,
} from "./src/review.js";

const PLUGIN_ID = "advisor";
const ADVISOR_TOOL = "advisor_review";
const ADVISOR_TITLE_PREFIX = "Advisor · ";
/**
 * Permission modes the reviewer will accept, least privileged first. The mode
 * is negotiated against what the provider actually advertises rather than
 * hardcoded, because bb only gained a real `readonly` mode recently: pinning
 * it would make every review report unavailable on a bb that predates it,
 * while pinning `accept-edits` would keep handing the reviewer workspace write
 * access forever on a bb that has something narrower. Picking the value out of
 * the provider's own `supportedPermissionModes` also keeps this typed on both
 * versions without a cast.
 */
const ADVISOR_PERMISSION_MODE_PREFERENCE = ["readonly", "accept-edits"];
const ADVISOR_PERMISSION_MODE_LABEL = "read-only (or accept-edits) mode";
/** The host's own permission-mode union, whichever bb version is running. */
type AdvisorPermissionMode = NonNullable<
  Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["permissionMode"]
>;
/** Advice about a turn this old is stale; it is retired instead of injected. */
const PENDING_ADVICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CANCELLED_REASON =
  "the primary turn was cancelled before the review finished";
/**
 * Advice must carry this much normalized text before it can join a repeat
 * chain. Chaining is text equality, so a terse generic line ("rename the
 * helper") could otherwise collide with an unrelated later finding — and, since
 * a repeat inherits the chain's strongest severity, hand it a blocker it never
 * earned. Long identical text is the same advice; short identical text is not.
 */
const MIN_CHAINABLE_ADVICE_LENGTH = 40;
/** Keeps the closable-findings list in the prompt bounded on a long thread. */
const MAX_PROMPTED_OPEN_FINDINGS = 20;
/** Bound one turn's carried advice without dropping later queued findings. */
const MAX_PENDING_ADVICE_PER_TURN = 20;
/** Per-thread cap so a persistently failing advisor cannot grow the table forever. */
const MAX_INCIDENTS_PER_THREAD = 50;

const reasoningLevelSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
]);
const savedReasoningLevelSchema = z.union([
  z.literal("default"),
  reasoningLevelSchema,
]);
type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

const modelIdentitySchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();

const modelSelectionSchema = modelIdentitySchema.extend({
  reasoningLevel: savedReasoningLevelSchema,
});

const modelOptionSchema = modelIdentitySchema.extend({
  providerName: z.string(),
  modelName: z.string(),
  isDefault: z.boolean(),
  supportedReasoningLevels: z.array(reasoningLevelSchema),
  defaultReasoningLevel: reasoningLevelSchema,
});

const hostModelConfigurationSchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  connected: z.boolean(),
  selection: modelSelectionSchema.nullable(),
  options: z.array(modelOptionSchema),
  error: z.string().nullable(),
});

const modelConfigurationOutputSchema = z.object({
  hosts: z.array(hostModelConfigurationSchema),
});

export type ModelConfiguration = z.infer<
  typeof modelConfigurationOutputSchema
>;

const severitySchema = z.enum(["pass", "nit", "concern", "blocker"]);
/** '' is a finding resolved before decisions were recorded. */
const decisionSchema = z.enum(["", "fixed", "not-an-issue", "wont-fix"]);
// `fixed` remains readable for legacy rows, but new user actions cannot write
// it. A fix becomes fact only when a later Advisor round closes the chain.
const userDecisionSchema = z.enum(["not-an-issue", "wont-fix"]);
const SEVERITY_RANK: Record<AdvisorSeverity, number> = {
  pass: 0,
  nit: 1,
  concern: 2,
  blocker: 3,
};

const threadTargetSchema = z.object({ threadId: z.string().min(1) }).strict();

/**
 * One repeat chain collapsed to its latest round. `repeatCount` > 1 means the
 * same advice was given again and is still unresolved.
 */
const panelReviewSchema = z.object({
  id: z.number().int(),
  /**
   * Stable across repeat rounds. The row `id` moves to the newest round, so
   * keying UI state on it collapses whatever the user had open the moment the
   * advisor re-flags the finding they were reading.
   */
  chainId: z.number().int(),
  severity: severitySchema,
  summary: z.string(),
  details: z.string(),
  sourceSeq: z.number().int(),
  createdAt: z.number(),
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.string(),
  repeatCount: z.number().int(),
  firstSourceSeq: z.number().int(),
  /** When the finding was first raised, for a human-readable "first flagged". */
  firstCreatedAt: z.number(),
  advisorThreadId: z.string().nullable(),
  resolvedAt: z.number().nullable(),
  resolvedReason: z.string(),
  /** When the finding's text actually reached the primary agent. */
  sentAt: z.number().nullable(),
  decision: decisionSchema,
  /** Set when the advisor itself re-checked the finding and closed it. */
  closedAt: z.number().nullable(),
  closedSeq: z.number().int().nullable(),
  /** This exact review round already started a corrective follow-up turn. */
  continuedAt: z.number().nullable(),
});

/** A review that never happened. Kept apart from verdicts on purpose. */
const incidentSchema = z.object({
  id: z.number().int(),
  reason: z.string(),
  sourceSeq: z.number().int(),
  createdAt: z.number(),
});

const pendingAdviceSchema = z.object({
  id: z.number().int(),
  severity: severitySchema,
  summary: z.string(),
  details: z.string(),
  repeatCount: z.number().int(),
});

const reviewLifecycleSchema = z.enum([
  "unreviewed",
  "waiting",
  "pending",
  "approved",
  "changes-requested",
  "decided",
  "unavailable",
]);

export const rpcContract = defineRpcContract({
  modelConfiguration: {
    input: z.null(),
    output: modelConfigurationOutputSchema,
  },
  threadReviews: {
    input: threadTargetSchema,
    output: z.object({
      reviews: z.array(panelReviewSchema),
      incidents: z.array(incidentSchema),
      advisorThreadId: z.string().nullable(),
      reviewing: z.boolean(),
      lifecycle: reviewLifecycleSchema,
    }),
  },
  threadBadge: {
    input: threadTargetSchema,
    output: z.object({
      open: z
        .object({
          chainId: z.number().int(),
          severity: severitySchema,
          summary: z.string(),
          repeatCount: z.number().int(),
        })
        .nullable(),
      latest: z
        .object({
          severity: severitySchema,
          summary: z.string(),
          repeatCount: z.number().int(),
        })
        .nullable(),
      unavailableCount: z.number().int(),
      /** The most recent thing that happened was a failed review, not a verdict. */
      latestIsUnavailable: z.boolean(),
      latestUnavailableReason: z.string().nullable(),
      reviewing: z.boolean(),
      lifecycle: reviewLifecycleSchema,
    }),
  },
  pendingAdvice: {
    input: threadTargetSchema,
    output: z.object({ advice: pendingAdviceSchema.nullable() }),
  },
  /**
   * Checked on demand rather than for every listed review: a reviewer thread
   * can be deleted, and embedding a chat for a thread that is gone shows the
   * host's raw failure inside the panel.
   */
  reviewerThreadAvailable: {
    input: z
      .object({
        // Scoped: without the owning thread this would probe the existence of
        // any thread id the caller cares to guess.
        threadId: z.string().min(1),
        advisorThreadId: z.string().min(1),
      })
      .strict(),
    output: z.object({ available: z.boolean() }),
  },
  dismissAdvice: {
    input: z
      .object({
        threadId: z.string().min(1),
        // Required: dismissing by thread alone would retire a newer finding
        // that arrived after the banner rendered and was never seen.
        adviceId: z.number().int(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true), dismissed: z.boolean() }),
  },
  resolveFinding: {
    input: z
      .object({
        threadId: z.string().min(1),
        chainId: z.number().int(),
        resolved: z.boolean(),
        reason: z.string().max(500).default(""),
        decision: userDecisionSchema.default("not-an-issue"),
      })
      .strict(),
    output: z.object({
      ok: z.literal(true),
      resolved: z.boolean(),
    }),
  },
  requestReview: {
    input: threadTargetSchema,
    output: z.object({ started: z.boolean(), waiting: z.boolean() }),
  },
  continueFinding: {
    input: z
      .object({
        threadId: z.string().min(1),
        reviewId: z.number().int(),
      })
      .strict(),
    output: z.object({
      started: z.boolean(),
      reason: z.enum(["started", "already-started", "not-open"]),
    }),
  },
  setHostModel: {
    input: z
      .object({
        hostId: z.string().min(1),
        selection: modelSelectionSchema.nullable(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
});

const reviewRowSchema = z.object({
  id: z.number().int(),
  primary_thread_id: z.string(),
  source_seq: z.number().int().nonnegative(),
  severity: z.enum(["pass", "nit", "concern", "blocker"]),
  summary: z.string(),
  details: z.string(),
  normalized: z.string(),
  created_at: z.number(),
  delivered_at: z.number().nullable(),
  repeat_of: z.number().int().nullable(),
  provider_id: z.string(),
  model: z.string(),
  reasoning_level: z.string(),
  advisor_thread_id: z.string(),
  finding_key: z.string(),
  resolved_at: z.number().nullable(),
  resolved_reason: z.string(),
  sent_at: z.number().nullable(),
  closed_at: z.number().nullable(),
  closed_seq: z.number().int().nullable(),
  decision: decisionSchema,
  continued_at: z.number().nullable(),
  auto_continued_at: z.number().nullable(),
});

const incidentRowSchema = z.object({
  id: z.number().int(),
  source_seq: z.number().int(),
  reason: z.string(),
  created_at: z.number(),
});

type ReviewRow = z.infer<typeof reviewRowSchema>;

const chainRootRowSchema = z.object({
  id: z.number().int(),
  severity: z.enum(["pass", "nit", "concern", "blocker"]),
  resolved_at: z.number().nullable(),
  resolved_reason: z.string(),
  closed_at: z.number().nullable(),
  closed_seq: z.number().int().nullable(),
  decision: decisionSchema,
  auto_continued_at: z.number().nullable(),
});

const sessionRowSchema = z.object({
  advisor_thread_id: z.string(),
  provider_id: z.string(),
  model: z.string(),
  reasoning_level: z.string(),
  environment_id: z.string(),
  permission_mode: z.string(),
});

const hostModelRowSchema = z.object({
  host_id: z.string(),
  provider_id: z.string(),
  model: z.string(),
  reasoning_level: savedReasoningLevelSchema,
});

interface PrimaryContext {
  projectId: string;
  providerId: string;
  model: string;
  environmentId: string;
  hostId: string;
}

interface RuntimeSettings {
  enabled: boolean;
  autoReview: boolean;
  autoContinue: boolean;
  advisorReasoning: "inherit" | "low" | "medium" | "high" | "xhigh";
  severityThreshold: AdvisorSeverity;
  watchdogFile: string;
  timeoutSeconds: number;
  transcriptSize: number;
}

const TIMEOUT_OPTIONS = [
  ["30 seconds", "30", 30],
  ["1 minute", "60", 60],
  ["2 minutes", "120", 120],
  ["5 minutes", "300", 300],
  ["10 minutes", "600", 600],
] as const;
const TRANSCRIPT_OPTIONS = [
  ["20,000 characters", "20000", 20_000],
  ["60,000 characters", "60000", 60_000],
  ["120,000 characters", "120000", 120_000],
] as const;

/**
 * Every string the host may hand back for a numeric select: the readable
 * labels first, then the legacy numeric values this plugin used to persist.
 *
 * The legacy entries are load-bearing, not clutter. The host reads stored
 * settings in apps/server/src/services/plugins/plugin-settings.ts and discards
 * any select value missing from `options`, substituting `descriptor.default`
 * before `settings.get()` ever returns it. Dropping "30" from this list would
 * therefore not fall through to `numericSetting`'s legacy mapping — it would
 * silently reset an existing 30-second timeout to two minutes.
 */
function selectOptions(
  options: readonly (readonly [label: string, legacy: string, value: number])[],
): string[] {
  return [
    ...options.map(([label]) => label),
    ...options.map(([, legacy]) => legacy),
  ];
}

function numericSetting(
  options: readonly (readonly [label: string, legacy: string, value: number])[],
  fallback: number,
) {
  const values = new Map(
    options.flatMap(([label, legacy, value]) => [
      [label, value] as const,
      [legacy, value] as const,
    ]),
  );
  return z.unknown().transform((value) =>
    typeof value === "string" ? (values.get(value) ?? fallback) : fallback,
  );
}

const runtimeSettingsSchema: z.ZodType<RuntimeSettings> = z.object({
  enabled: z.boolean(),
  autoReview: z.boolean(),
  autoContinue: z.boolean(),
  advisorReasoning: z.enum(["inherit", "low", "medium", "high", "xhigh"]),
  severityThreshold: z.enum(["pass", "nit", "concern", "blocker"]),
  watchdogFile: z.string(),
  timeoutSeconds: numericSetting(TIMEOUT_OPTIONS, 120),
  transcriptSize: numericSetting(TRANSCRIPT_OPTIONS, 60_000),
});

export function parseRuntimeSettings(value: unknown) {
  return runtimeSettingsSchema.parse(value);
}

const REVIEW_COLUMNS = `id, primary_thread_id, source_seq, severity, summary,
          details, normalized, created_at, delivered_at, repeat_of,
          provider_id, model, reasoning_level, advisor_thread_id,
          finding_key, resolved_at, resolved_reason, sent_at, closed_at,
          closed_seq, decision, continued_at, auto_continued_at`;

/**
 * Newest first by the turn reviewed, not by insertion order: a review of an
 * earlier turn can be written after a later one, and it is not "the latest
 * verdict".
 */
function byTurnDescending(
  left: { source_seq: number; id: number },
  right: { source_seq: number; id: number },
): number {
  return right.source_seq - left.source_seq || right.id - left.id;
}

/**
 * All rounds of one finding share a chain key: the first row's id. `repeat_of`
 * always points at that first row, so a chain never forms a longer path.
 */
function chainKeyOf(row: { id: number; repeat_of: number | null }): number {
  return row.repeat_of ?? row.id;
}

/**
 * The result of asking for a review. An advisor that could not run is
 * explicitly `unavailable` rather than a `pass`, so a failure can never read
 * as approval.
 */
type AdvisorOutcome =
  | { kind: "reviewed"; row: ReviewRow }
  | { kind: "unavailable"; reason: string };

/**
 * The narrowest mode in {@link ADVISOR_PERMISSION_MODE_PREFERENCE} this
 * provider supports, or null when it supports none of them. The value is taken
 * from `supported` rather than from the preference list so it stays typed as
 * the host's own permission-mode union on whichever bb version is running.
 */
function narrowestReviewMode<Mode extends string>(
  supported: readonly Mode[],
): Mode | null {
  for (const preferred of ADVISOR_PERMISSION_MODE_PREFERENCE) {
    const match = supported.find((mode) => mode === preferred);
    if (match !== undefined) return match;
  }
  return null;
}

/** A model the reviewer can actually be spawned with, or why it cannot be. */
type AdvisorModelResolution =
  | {
      kind: "ready";
      providerId: string;
      model: string;
      reasoningLevel: ReasoningLevel | null;
      /**
       * Ordered narrowest-first. Exactly one entry when the catalog answered;
       * the whole preference list when it could not be read, in which case the
       * spawn itself is the check and each is tried in turn. Never widened
       * without evidence that the narrower one was refused.
       */
      permissionModeCandidates: readonly string[];
    }
  | { kind: "unavailable"; reason: string };

function rowToReview(row: ReviewRow): AdvisorFinding {
  return {
    severity: row.severity,
    key: row.finding_key,
    summary: row.summary,
    details: row.details,
    repeatOf: row.repeat_of,
  };
}

function formatOutcome(outcome: AdvisorOutcome): string {
  if (outcome.kind === "reviewed") return formatReview(rowToReview(outcome.row));
  return `Advisor unavailable: ${outcome.reason}. No review was performed, so this is NOT an approval — say plainly that the advisor did not run instead of claiming the work was reviewed.`;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (!("body" in error)) return String(error);
  try {
    return `${String(error)}; body=${JSON.stringify(error.body)}`;
  } catch {
    return String(error);
  }
}

function reviewBudget(timeoutSeconds: number): {
  reserveSeconds: number;
  maxInspectionActions: number;
  finalizeAfterMs: number;
} {
  const reserveSeconds = Math.min(
    30,
    Math.max(5, Math.ceil(timeoutSeconds / 4)),
  );
  const inspectionSeconds = Math.max(1, timeoutSeconds - reserveSeconds);
  return {
    reserveSeconds,
    maxInspectionActions: Math.max(
      1,
      Math.min(6, Math.floor(inspectionSeconds / 15)),
    ),
    finalizeAfterMs: inspectionSeconds * 1000,
  };
}

function buildAdvisorPrompt(args: {
  primaryThreadId: string;
  sourceSeq: number;
  transcript: string;
  focus: string;
  watchdogFile: string;
  timeoutSeconds: number;
  openFindings: readonly { key: string; summary: string }[];
  openFindingsTruncated: boolean;
}): string {
  const budget = reviewBudget(args.timeoutSeconds);
  return `You are the independent advisor for bb coding thread ${args.primaryThreadId}.

Review the primary agent's work, reasoning summaries, tool activity, and current workspace state. You are a reviewer, not the primary executor. Inspect files with read-only tools when the transcript alone is insufficient.

Before reviewing, try to read ${args.watchdogFile} from the workspace root. If it exists, treat it as project-specific review policy. If it does not exist, continue normally.

Review priorities:
- factual or API mistakes
- missed user requirements
- unsafe, destructive, or overly broad actions
- correctness gaps and untested behavior
- architecture or contract violations
- claims that are not supported by verification

Review budget:
- The host stops this review after ${args.timeoutSeconds} seconds. Finish and emit the structured result before then; reserve the final ${budget.reserveSeconds} seconds for it.
- Do not send progress updates. Your only assistant message must be the final ADVISOR_RESULT block.
- Use the supplied timeline and focus first. Inspect only files needed to verify a concrete risk; do not broadly inventory the workspace.
- Perform at most ${budget.maxInspectionActions} read-only inspection or command actions. Do not rerun broad test suites or builds—the primary agent already owns verification.
- If exhaustive verification would exceed the budget, report the strongest concrete issue you can support, or pass when you found none. Never omit the result format.

Findings you raised earlier on this thread that are still open:
${
  args.openFindings.length === 0
    ? "None."
    : args.openFindings
        .map((finding) => `- ${finding.key}: ${finding.summary}`)
        .join("\n") +
      (args.openFindingsTruncated
        ? "\n- (older open findings omitted)"
        : "")
}

If you have re-checked one of those and it is genuinely addressed now, list its key on the "resolved:" line. Only close a key you actually verified in this round: not mentioning a finding never closes it, and you must not close one you did not check. Closing a key that is not listed above does nothing.

Focus supplied by the primary agent:
${args.focus || "No additional focus was supplied."}

Primary timeline through sequence ${args.sourceSeq} (JSONL, oldest selected row first):
${args.transcript}

Return exactly one result in this format. Use pass and silence-equivalent details when there is no actionable issue. Do not repeat old advice merely to have something to say.

ADVISOR_RESULT
severity: pass|nit|concern|blocker
key: a short stable slug naming the defect itself, anchored to where it lives, e.g. server-ts-runreview-timeout-untested. Use the SAME key whenever you raise the same underlying defect again, even if you reword it or rate it differently. Use "none" for a pass.
summary: one concise line
details:
- concrete evidence and a specific correction, or "none"
resolved: comma-separated keys from the open list above that you verified are now fixed, or "none"
END_ADVISOR_RESULT`;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Enable advisor",
      description: "Require an independent review before an agent completes substantial work.",
      default: true,
    },
    autoReview: {
      type: "boolean",
      label: "Review completed turns",
      description: "Review every completed primary turn and carry late findings into its next turn.",
      default: true,
    },
    autoContinue: {
      type: "boolean",
      label: "Auto-continue on late findings",
      description:
        "Start one follow-up turn when a completed-turn review requests changes. Disabled by default to avoid unexpected agent runs.",
      default: false,
    },
    advisorReasoning: {
      type: "select",
      label: "Fallback advisor reasoning",
      description:
        "Used only when a machine follows the primary model instead of selecting its own model and reasoning level.",
      options: ["inherit", "low", "medium", "high", "xhigh"],
      default: "inherit",
    },
    severityThreshold: {
      type: "select",
      label: "Minimum severity",
      options: ["nit", "concern", "blocker"],
      default: "nit",
    },
    watchdogFile: {
      type: "string",
      label: "Watchdog file",
      description: "Workspace-relative advisor policy file.",
      default: "WATCHDOG.md",
    },
    timeoutSeconds: {
      type: "select",
      label: "Review timeout",
      description:
        "Seconds to wait for a review. Exceeding it reports the advisor as unavailable, never as a pass.",
      options: selectOptions(TIMEOUT_OPTIONS),
      default: "2 minutes",
    },
    transcriptSize: {
      type: "select",
      label: "Transcript budget",
      options: selectOptions(TRANSCRIPT_OPTIONS),
      default: "60,000 characters",
    },
  });

  let currentSettings = parseRuntimeSettings(await settings.get());
  settings.onChange((next) => {
    currentSettings = parseRuntimeSettings(next);
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS advisor_sessions (
      primary_thread_id TEXT PRIMARY KEY,
      advisor_thread_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS advisor_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      primary_thread_id TEXT NOT NULL,
      source_seq INTEGER NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('pass', 'nit', 'concern', 'blocker')),
      summary TEXT NOT NULL,
      details TEXT NOT NULL,
      normalized TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      UNIQUE(primary_thread_id, source_seq)
    )`,
    `CREATE INDEX IF NOT EXISTS advisor_reviews_pending_idx
      ON advisor_reviews(primary_thread_id, delivered_at, id)`,
    `CREATE TABLE IF NOT EXISTS advisor_host_models (
      host_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `ALTER TABLE advisor_host_models
      ADD COLUMN reasoning_level TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE advisor_sessions
      ADD COLUMN reasoning_level TEXT NOT NULL DEFAULT 'legacy'`,
    `ALTER TABLE advisor_reviews ADD COLUMN repeat_of INTEGER`,
    // Legacy sessions carry no environment, so they never match a live one and
    // are rebuilt against the primary thread's current environment on first use.
    `ALTER TABLE advisor_sessions
      ADD COLUMN environment_id TEXT NOT NULL DEFAULT ''`,
    // Provenance per review, not per session: "who reviewed this" must survive
    // the machine's model selection changing afterwards.
    `ALTER TABLE advisor_reviews ADD COLUMN provider_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE advisor_reviews ADD COLUMN model TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE advisor_reviews
      ADD COLUMN reasoning_level TEXT NOT NULL DEFAULT ''`,
    // Reviews that never ran. Deliberately a separate table: an incident must
    // never be reachable by any query that treats rows as verdicts.
    `CREATE TABLE IF NOT EXISTS advisor_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      primary_thread_id TEXT NOT NULL,
      source_seq INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS advisor_incidents_thread_idx
      ON advisor_incidents(primary_thread_id, id)`,
    // Which reviewer thread actually produced this row. The session pointer
    // moves when the reviewer is respawned, so it cannot answer that for history.
    `ALTER TABLE advisor_reviews
      ADD COLUMN advisor_thread_id TEXT NOT NULL DEFAULT ''`,
    // The advisor's own identifier for the defect, so a chain survives
    // rewording and a changed severity.
    `ALTER TABLE advisor_reviews
      ADD COLUMN finding_key TEXT NOT NULL DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS advisor_reviews_chain_idx
      ON advisor_reviews(primary_thread_id, finding_key)`,
    `ALTER TABLE advisor_reviews ADD COLUMN resolved_at INTEGER`,
    `ALTER TABLE advisor_reviews ADD COLUMN resolved_reason TEXT NOT NULL DEFAULT ''`,
    // The mode is negotiated per review, so a bb upgrade that adds a narrower
    // one must retire the wider session instead of reusing it. Legacy rows
    // carry '', which matches no negotiated mode and so respawns once.
    `ALTER TABLE advisor_sessions
      ADD COLUMN permission_mode TEXT NOT NULL DEFAULT ''`,
    // When the finding's text actually reached the primary agent. Distinct
    // from delivered_at, which only tracks the pending-advice queue and is set
    // in bulk, so it cannot back a "sent to the agent" claim.
    `ALTER TABLE advisor_reviews ADD COLUMN sent_at INTEGER`,
    // Advisor-verified closure, on the chain root. Provisional by design: a
    // later round of the same key reopens it, because a finding that comes
    // back was a regression, not a closure.
    `ALTER TABLE advisor_reviews ADD COLUMN closed_at INTEGER`,
    `ALTER TABLE advisor_reviews ADD COLUMN closed_seq INTEGER`,
    // What the user decided, so a finding they fixed is distinguishable from
    // one they overruled. Rows resolved before this column carry '' and stay
    // a plain dismissal rather than being backfilled with a guess.
    `ALTER TABLE advisor_reviews ADD COLUMN decision TEXT NOT NULL DEFAULT ''`,
    // Manual continuation is idempotent per review round. Automatic
    // continuation is capped once per finding chain so a persistent finding
    // cannot create an unattended agent/reviewer loop.
    `ALTER TABLE advisor_reviews ADD COLUMN continued_at INTEGER`,
    `ALTER TABLE advisor_reviews ADD COLUMN auto_continued_at INTEGER`,
  ]);

  const primaryContexts = new Map<string, PrimaryContext>();
  const inFlight = new Map<string, Promise<AdvisorOutcome>>();
  const reviewingThreads = new Map<string, number>();
  /** Manual reviews requested while the primary turn is still active. */
  const waitingForCompletion = new Set<string>();
  /**
   * Primary threads whose current turn already ran a tool review, so the
   * post-turn pass would only re-review the same work at a higher sequence.
   */
  const toolReviewedThreads = new Set<string>();

  // Retire advice that can no longer be delivered: rows older than the window,
  // including any left undeliverable by the pre-fix post-turn handler, which
  // reviewed other plugins' threads that never consume pending advice.
  db.prepare(
    `UPDATE advisor_reviews SET delivered_at = ?
     WHERE delivered_at IS NULL AND created_at < ?`,
  ).run(Date.now(), Date.now() - PENDING_ADVICE_MAX_AGE_MS);

  // Versions before the persisted queue fix could bulk-mark older findings
  // delivered when only a newer tool result reached the agent. A shared
  // millisecond with a genuinely sent row identifies that bulk sweep without
  // resurrecting individually dismissed advice.
  db.prepare(
    `UPDATE advisor_reviews AS stale
     SET delivered_at = NULL
     WHERE stale.sent_at IS NULL
       AND stale.severity != 'pass'
       AND stale.delivered_at IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM advisor_reviews AS sent
         WHERE sent.primary_thread_id = stale.primary_thread_id
           AND sent.delivered_at = stale.delivered_at
           AND sent.sent_at IS NOT NULL
       )`,
  ).run();

  /**
   * Tell every open client that this thread's advisor state moved. The payload
   * is only an invalidation hint — surfaces refetch over rpc rather than trust
   * an ephemeral broadcast that a reconnecting client may have missed.
   */
  function publishThreadChanged(primaryThreadId: string): void {
    bb.realtime.publish("thread-changed", { threadId: primaryThreadId });
  }

  function readChainRoot(
    primaryThreadId: string,
    chainId: number,
  ): z.infer<typeof chainRootRowSchema> | null {
    const parsed = chainRootRowSchema.safeParse(
      db
        .prepare(
          `SELECT id, severity, resolved_at, resolved_reason, closed_at,
                  closed_seq, decision, auto_continued_at
           FROM advisor_reviews
           WHERE primary_thread_id = ? AND id = ? AND repeat_of IS NULL`,
        )
        .get(primaryThreadId, chainId),
    );
    return parsed.success ? parsed.data : null;
  }

  /**
   * Settled from either direction: the user decided it, or the advisor
   * re-checked and closed it. Both keep a finding out of the badge and out of
   * the next turn's instructions.
   */
  function chainIsResolved(row: ReviewRow): boolean {
    const root = readChainRoot(row.primary_thread_id, chainKeyOf(row));
    if (!root) return false;
    return root.resolved_at !== null || root.closed_at !== null;
  }

  function isReviewing(primaryThreadId: string): boolean {
    return (reviewingThreads.get(primaryThreadId) ?? 0) > 0;
  }

  function beginReview(primaryThreadId: string): void {
    const current = reviewingThreads.get(primaryThreadId) ?? 0;
    reviewingThreads.set(primaryThreadId, current + 1);
    if (current === 0) publishThreadChanged(primaryThreadId);
  }

  function endReview(primaryThreadId: string): void {
    const current = reviewingThreads.get(primaryThreadId) ?? 0;
    if (current <= 1) {
      reviewingThreads.delete(primaryThreadId);
      publishThreadChanged(primaryThreadId);
      return;
    }
    reviewingThreads.set(primaryThreadId, current - 1);
  }

  function recordIncident(
    primaryThreadId: string,
    sourceSeq: number,
    reason: string,
  ): void {
    db.prepare(
      `INSERT INTO advisor_incidents (
         primary_thread_id, source_seq, reason, created_at
       ) VALUES (?, ?, ?, ?)`,
    ).run(primaryThreadId, sourceSeq, reason, Date.now());
    // An advisor that fails every turn would otherwise grow this table without
    // bound; only the most recent failures are diagnostically useful.
    db.prepare(
      `DELETE FROM advisor_incidents
       WHERE primary_thread_id = ? AND id NOT IN (
         SELECT id FROM advisor_incidents
         WHERE primary_thread_id = ? ORDER BY id DESC LIMIT ?
       )`,
    ).run(primaryThreadId, primaryThreadId, MAX_INCIDENTS_PER_THREAD);
    publishThreadChanged(primaryThreadId);
  }

  function readReview(primaryThreadId: string, sourceSeq: number): ReviewRow | null {
    const parsed = reviewRowSchema.safeParse(
      db
        .prepare(
          `SELECT ${REVIEW_COLUMNS}
           FROM advisor_reviews
           WHERE primary_thread_id = ? AND source_seq = ?`,
        )
        .get(primaryThreadId, sourceSeq),
    );
    return parsed.success ? parsed.data : null;
  }

  /**
   * Record that this finding's text actually reached the primary agent. Only
   * the two moments that genuinely hand it over call this — the tool result
   * and the injected instruction — so "sent to the agent" stays a fact rather
   * than an artefact of the pending-advice sweep.
   */
  function markSent(rowId: number): void {
    db.prepare(
      `UPDATE advisor_reviews SET sent_at = ? WHERE id = ? AND sent_at IS NULL`,
    ).run(Date.now(), rowId);
  }

  function readPendingAdvice(primaryThreadId: string): ReviewRow[] {
    return db
      .prepare(
        `SELECT ${REVIEW_COLUMNS}
         FROM advisor_reviews
         WHERE primary_thread_id = ?
           AND delivered_at IS NULL
           AND severity != 'pass'
         ORDER BY CASE severity
           WHEN 'blocker' THEN 3
           WHEN 'concern' THEN 2
           WHEN 'nit' THEN 1
           ELSE 0 END DESC,
           source_seq ASC, id ASC`,
      )
      .all(primaryThreadId)
      .flatMap((candidate) => {
        const parsed = reviewRowSchema.safeParse(candidate);
        return parsed.success && !chainIsResolved(parsed.data)
          ? [parsed.data]
          : [];
      });
  }

  function markReviewDelivered(rowId: number, sent: boolean): void {
    db.prepare(
      `UPDATE advisor_reviews SET delivered_at = ?
       WHERE id = ? AND delivered_at IS NULL`,
    ).run(Date.now(), rowId);
    if (sent) markSent(rowId);
  }

  function consumePending(primaryThreadId: string): ReviewRow[] {
    const rows = readPendingAdvice(primaryThreadId).slice(
      0,
      MAX_PENDING_ADVICE_PER_TURN,
    );
    if (rows.length === 0) return [];
    db.transaction(() => {
      for (const row of rows) markReviewDelivered(row.id, true);
    })();
    publishThreadChanged(primaryThreadId);
    return rows;
  }

  function rememberContext(context: PluginAgentConfigurationContext): void {
    primaryContexts.set(context.thread.id, {
      projectId: context.project.id,
      providerId: context.provider.id,
      model: context.provider.model,
      environmentId: context.environment.id,
      hostId: context.host.id,
    });
  }

  function readHostModel(hostId: string) {
    const parsed = hostModelRowSchema.safeParse(
      db
        .prepare(
          `SELECT host_id, provider_id, model, reasoning_level
           FROM advisor_host_models WHERE host_id = ?`,
        )
        .get(hostId),
    );
    return parsed.success
      ? {
          providerId: parsed.data.provider_id,
          model: parsed.data.model,
          reasoningLevel: parsed.data.reasoning_level,
        }
      : null;
  }

  async function listHostModelOptions(hostId: string) {
    const providers = (await bb.sdk.providers.list({ hostId })).filter(
      (provider) =>
        provider.available &&
        narrowestReviewMode(provider.capabilities.supportedPermissionModes) !==
          null,
    );
    const optionGroups = await Promise.all(
      providers.map(async (provider) => {
        const catalog = await bb.sdk.providers.models({
          hostId,
          providerId: provider.id,
        });
        if (catalog.modelLoadError !== null) return [];
        return catalog.models.map((model) => ({
          providerId: provider.id,
          providerName: provider.displayName,
          model: model.model,
          modelName: model.displayName || model.model,
          isDefault: model.isDefault,
          supportedReasoningLevels: model.supportedReasoningEfforts.map(
            (effort) => effort.reasoningEffort,
          ),
          defaultReasoningLevel: model.defaultReasoningEffort,
        }));
      }),
    );
    return optionGroups
      .flat()
      .sort((left, right) =>
        `${left.providerName}\0${left.modelName}`.localeCompare(
          `${right.providerName}\0${right.modelName}`,
        ),
      );
  }

  async function modelConfiguration() {
    const hosts = await bb.sdk.hosts.list();
    return {
      hosts: await Promise.all(
        hosts.map(async (host) => {
          if (host.status !== "connected") {
            return {
              hostId: host.id,
              hostName: host.name,
              connected: false,
              selection: readHostModel(host.id),
              options: [],
              error: "Machine is disconnected; its live model catalog is unavailable.",
            };
          }
          try {
            return {
              hostId: host.id,
              hostName: host.name,
              connected: true,
              selection: readHostModel(host.id),
              options: await listHostModelOptions(host.id),
              error: null,
            };
          } catch (error) {
            return {
              hostId: host.id,
              hostName: host.name,
              connected: true,
              selection: readHostModel(host.id),
              options: [],
              error: `Could not load models: ${String(error)}`,
            };
          }
        }),
      ),
    };
  }

  function readThreadRows(primaryThreadId: string): ReviewRow[] {
    return db
      .prepare(
        `SELECT ${REVIEW_COLUMNS} FROM advisor_reviews
         WHERE primary_thread_id = ? ORDER BY id`,
      )
      .all(primaryThreadId)
      .flatMap((row) => {
        const parsed = reviewRowSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      });
  }

  /**
   * Collapse each repeat chain to its latest round, newest chain first. A user
   * scanning this needs "one finding, flagged 3×", not three near-identical rows.
   */
  function collapseChains(rows: readonly ReviewRow[]) {
    const chains = new Map<number, ReviewRow[]>();
    for (const row of rows) {
      const key = chainKeyOf(row);
      const chain = chains.get(key);
      if (chain) chain.push(row);
      else chains.set(key, [row]);
    }
    return [...chains.values()]
      .map((chain) => {
        const ordered = [...chain].sort(byTurnDescending);
        const latest = ordered[0]!;
        const first = ordered[ordered.length - 1]!;
        const root = chain.find((row) => row.id === chainKeyOf(row)) ?? first;
        return {
          id: latest.id,
          chainId: chainKeyOf(latest),
          severity: latest.severity,
          summary: latest.summary,
          details: latest.details,
          sourceSeq: latest.source_seq,
          createdAt: latest.created_at,
          providerId: latest.provider_id,
          model: latest.model,
          reasoningLevel: latest.reasoning_level,
          repeatCount: chain.length,
          firstSourceSeq: first.source_seq,
          firstCreatedAt: first.created_at,
          advisorThreadId: latest.advisor_thread_id || null,
          // The key the advisor would name today. Legacy rounds carry '',
          // so fall back to the root's before giving up on the chain.
          findingKey: latest.finding_key || root.finding_key,
          resolvedAt: root.resolved_at,
          resolvedReason: root.resolved_reason,
          // Any round reaching the agent makes the chain "sent"; the most
          // recent one is what the user cares about.
          sentAt: chain.reduce<number | null>(
            (latestSent, row) =>
              row.sent_at === null
                ? latestSent
                : Math.max(latestSent ?? 0, row.sent_at),
            null,
          ),
          decision: root.decision,
          closedAt: root.closed_at,
          closedSeq: root.closed_seq,
          continuedAt: latest.continued_at,
        };
      })
      .sort((left, right) =>
        right.sourceSeq - left.sourceSeq || right.id - left.id,
      );
  }

  function readThreadIncidents(primaryThreadId: string) {
    return db
      .prepare(
        `SELECT id, source_seq, reason, created_at FROM advisor_incidents
         WHERE primary_thread_id = ? ORDER BY source_seq DESC, id DESC
         LIMIT 50`,
      )
      .all(primaryThreadId)
      .flatMap((row) => {
        const parsed = incidentRowSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      });
  }

  function readAdvisorThreadId(primaryThreadId: string): string | null {
    const parsed = z
      .object({ advisor_thread_id: z.string() })
      .safeParse(
        db
          .prepare(
            `SELECT advisor_thread_id FROM advisor_sessions
             WHERE primary_thread_id = ?`,
          )
          .get(primaryThreadId),
      );
    return parsed.success ? parsed.data.advisor_thread_id : null;
  }

  function reviewLifecycle(primaryThreadId: string) {
    if (waitingForCompletion.has(primaryThreadId)) return "waiting" as const;
    if (isReviewing(primaryThreadId)) return "pending" as const;
    const rows = readThreadRows(primaryThreadId);
    const latestRow = [...rows].sort(byTurnDescending)[0] ?? null;
    const latestIncident = readThreadIncidents(primaryThreadId)[0] ?? null;
    if (
      latestIncident !== null &&
      (latestRow === null || latestIncident.source_seq >= latestRow.source_seq)
    ) {
      return "unavailable" as const;
    }
    const hasOpenFinding = collapseChains(rows).some(
      (chain) =>
        chain.severity !== "pass" &&
        chain.resolvedAt === null &&
        chain.closedAt === null,
    );
    if (hasOpenFinding) return "changes-requested" as const;
    if (latestRow?.severity === "pass") return "approved" as const;
    if (latestRow !== null) return "decided" as const;
    return "unreviewed" as const;
  }

  async function continueWithFinding(
    primaryThreadId: string,
    reviewId: number,
    automatic: boolean,
  ): Promise<"started" | "already-started" | "not-open"> {
    const row = reviewRowSchema.safeParse(
      db
        .prepare(`SELECT ${REVIEW_COLUMNS} FROM advisor_reviews WHERE id = ?`)
        .get(reviewId),
    );
    if (!row.success || row.data.primary_thread_id !== primaryThreadId) {
      return "not-open";
    }
    const review = row.data;
    const chainId = chainKeyOf(review);
    if (review.severity === "pass" || chainIsResolved(review)) {
      return "not-open";
    }

    const claim = db.transaction(() => {
      if (automatic) {
        const rootClaim = db
          .prepare(
            `UPDATE advisor_reviews SET auto_continued_at = ?
             WHERE primary_thread_id = ? AND id = ?
               AND repeat_of IS NULL AND auto_continued_at IS NULL`,
          )
          .run(Date.now(), primaryThreadId, chainId);
        if (rootClaim.changes === 0) return false;
      }
      const roundClaim = db
        .prepare(
          `UPDATE advisor_reviews SET continued_at = ?
           WHERE primary_thread_id = ? AND id = ? AND continued_at IS NULL`,
        )
        .run(Date.now(), primaryThreadId, review.id);
      if (roundClaim.changes === 0) {
        if (automatic) {
          db.prepare(
            `UPDATE advisor_reviews SET auto_continued_at = NULL
             WHERE primary_thread_id = ? AND id = ?`,
          ).run(primaryThreadId, chainId);
        }
        return false;
      }
      return true;
    })();
    if (!claim) return "already-started";

    const wasPending = review.delivered_at === null;
    if (wasPending) {
      db.prepare(
        `UPDATE advisor_reviews SET delivered_at = ? WHERE id = ?`,
      ).run(Date.now(), review.id);
    }
    publishThreadChanged(primaryThreadId);

    try {
      await bb.sdk.threads.send({
        threadId: primaryThreadId,
        mode: "queue-if-active",
        input: [
          {
            type: "text",
            visibility: "agent-only",
            text:
              `A completed-turn Advisor review requested changes:\n${formatReview(rowToReview(review))}\n` +
              "Address this now. Inspect the current state, make the correction, verify it, then run advisor_review before finalizing.",
            mentions: [],
          },
        ],
      });
      markSent(review.id);
      publishThreadChanged(primaryThreadId);
      return "started";
    } catch (error) {
      db.transaction(() => {
        db.prepare(
          `UPDATE advisor_reviews SET continued_at = NULL WHERE id = ?`,
        ).run(review.id);
        if (automatic) {
          db.prepare(
            `UPDATE advisor_reviews SET auto_continued_at = NULL
             WHERE primary_thread_id = ? AND id = ?`,
          ).run(primaryThreadId, chainId);
        }
        if (wasPending) {
          db.prepare(
            `UPDATE advisor_reviews SET delivered_at = NULL WHERE id = ?`,
          ).run(review.id);
        }
      })();
      publishThreadChanged(primaryThreadId);
      throw error;
    }
  }

  async function hasCompletedLatestTurn(primaryThreadId: string): Promise<boolean> {
    const timeline = await bb.sdk.threads.timeline({
      threadId: primaryThreadId,
      includeNestedRows: "true",
      segmentLimit: "2",
    });
    const conversations = timeline.rows.flatMap((candidate) => {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("kind" in candidate) ||
        candidate.kind !== "conversation" ||
        !("role" in candidate) ||
        (candidate.role !== "user" && candidate.role !== "assistant")
      ) {
        return [];
      }
      return [candidate];
    });
    const latestRequest = [...conversations]
      .reverse()
      .find(
        (row) =>
          row.role === "user" &&
          "turnId" in row &&
          typeof row.turnId === "string",
      );
    if (latestRequest && "turnId" in latestRequest) {
      return conversations.some(
        (row) =>
          row.role === "assistant" &&
          "turnId" in row &&
          row.turnId === latestRequest.turnId &&
          "text" in row &&
          typeof row.text === "string" &&
          row.text.trim().length > 0,
      );
    }
    // Compatibility for old/projected timelines without turn ids: only the
    // latest conversation row may prove that the current turn completed.
    const latest = conversations[conversations.length - 1];
    return (
      latest?.role === "assistant" &&
      "text" in latest &&
      typeof latest.text === "string" &&
      latest.text.trim().length > 0
    );
  }

  bb.rpc.register(rpcContract, {
    modelConfiguration,

    threadReviews({ threadId }) {
      return {
        reviews: collapseChains(readThreadRows(threadId)),
        incidents: readThreadIncidents(threadId).map((incident) => ({
          id: incident.id,
          reason: incident.reason,
          sourceSeq: incident.source_seq,
          createdAt: incident.created_at,
        })),
        advisorThreadId: readAdvisorThreadId(threadId),
        reviewing: isReviewing(threadId),
        lifecycle: reviewLifecycle(threadId),
      };
    },

    threadBadge({ threadId }) {
      const rows = readThreadRows(threadId);
      const latestRow = [...rows].sort(byTurnDescending)[0] ?? null;
      const open = collapseChains(rows)
        .filter(
          (chain) =>
            chain.severity !== "pass" &&
            chain.resolvedAt === null &&
            chain.closedAt === null,
        )
        .sort(
          (left, right) =>
            SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
            right.sourceSeq - left.sourceSeq ||
            right.id - left.id,
        )[0] ?? null;
      const incidents = readThreadIncidents(threadId);
      const latestIncident = incidents[0] ?? null;
      // A failure after the last verdict must not leave the badge advertising
      // that verdict: an outdated pass reads as a standing approval.
      const latestIsUnavailable =
        latestIncident !== null &&
        (latestRow === null ||
          latestIncident.source_seq >= latestRow.source_seq);
      return {
        open: open
          ? {
              chainId: open.chainId,
              severity: open.severity,
              summary: open.summary,
              repeatCount: open.repeatCount,
            }
          : null,
        latest: latestRow
          ? {
              severity: latestRow.severity,
              summary: latestRow.summary,
              repeatCount: rows.filter(
                (row) => chainKeyOf(row) === chainKeyOf(latestRow),
              ).length,
            }
          : null,
        unavailableCount: incidents.length,
        latestIsUnavailable,
        latestUnavailableReason: latestIsUnavailable
          ? (latestIncident?.reason ?? null)
          : null,
        reviewing: isReviewing(threadId),
        lifecycle: reviewLifecycle(threadId),
      };
    },

    pendingAdvice({ threadId }) {
      const row = readPendingAdvice(threadId)[0] ?? null;
      if (!row) return { advice: null };
      const rows = readThreadRows(threadId);
      return {
        advice: {
          id: row.id,
          severity: row.severity,
          summary: row.summary,
          details: row.details,
          repeatCount: rows.filter(
            (candidate) => chainKeyOf(candidate) === chainKeyOf(row),
          ).length,
        },
      };
    },

    async reviewerThreadAvailable({ threadId, advisorThreadId }) {
      // Only a reviewer this thread actually used may be probed.
      const owned = db
        .prepare(
          `SELECT 1 FROM advisor_reviews
           WHERE primary_thread_id = ? AND advisor_thread_id = ? LIMIT 1`,
        )
        .get(threadId, advisorThreadId);
      if (!owned) return { available: false };
      try {
        const thread = await bb.sdk.threads.get({ threadId: advisorThreadId });
        return { available: !thread.deletedAt };
      } catch {
        return { available: false };
      }
    },

    dismissAdvice({ threadId, adviceId }) {
      const row = readPendingAdvice(threadId).find(
        (candidate) => candidate.id === adviceId,
      ) ?? null;
      // Only the advice the banner actually showed is retired. If a newer
      // finding arrived after that render, the click must not discard it —
      // report not-dismissed so the client refetches and shows the new one.
      if (!row || row.id !== adviceId) {
        publishThreadChanged(threadId);
        return { ok: true, dismissed: false } as const;
      }
      db.prepare(`UPDATE advisor_reviews SET delivered_at = ? WHERE id = ?`).run(
        Date.now(),
        row.id,
      );
      publishThreadChanged(threadId);
      return { ok: true, dismissed: true } as const;
    },

    resolveFinding({ threadId, chainId, resolved, reason, decision }) {
      const root = readChainRoot(threadId, chainId);
      if (!root) {
        return { ok: true, resolved: false } as const;
      }

      const normalizedReason = resolved ? reason : "";
      const normalizedDecision = resolved ? decision : "";
      const alreadyResolved = root.resolved_at !== null;
      let changed =
        alreadyResolved !== resolved ||
        (resolved &&
          (root.resolved_reason !== normalizedReason ||
            root.decision !== normalizedDecision)) ||
        // Reopening must also discard an advisor closure, or the chain would
        // stay settled from the other direction and never come back.
        (!resolved && root.closed_at !== null);

      if (changed) {
        if (resolved) {
          db.prepare(
            `UPDATE advisor_reviews
             SET resolved_at = ?, resolved_reason = ?, decision = ?
             WHERE primary_thread_id = ? AND id = ? AND repeat_of IS NULL`,
          ).run(
            Date.now(),
            normalizedReason,
            normalizedDecision,
            threadId,
            chainId,
          );
        } else {
          // Reopening discards the advisor's closure too, or the chain stays
          // settled from the other direction and never actually comes back.
          db.prepare(
            `UPDATE advisor_reviews
             SET resolved_at = NULL, resolved_reason = '', decision = '',
                 closed_at = NULL, closed_seq = NULL,
                 auto_continued_at = NULL
             WHERE primary_thread_id = ? AND id = ? AND repeat_of IS NULL`,
          ).run(threadId, chainId);
        }
      }

      if (resolved) {
        const pendingInChain = readPendingAdvice(threadId).filter(
          (candidate) => chainKeyOf(candidate) === chainId,
        );
        for (const pending of pendingInChain) {
          markReviewDelivered(pending.id, false);
          changed = true;
        }
      }

      if (changed) publishThreadChanged(threadId);
      return { ok: true, resolved } as const;
    },

    async requestReview({ threadId }) {
      if (isReviewing(threadId)) return { started: false, waiting: false };
      if (waitingForCompletion.has(threadId)) {
        return { started: false, waiting: true };
      }
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status !== "idle") {
        waitingForCompletion.add(threadId);
        publishThreadChanged(threadId);
        return { started: false, waiting: true };
      }
      if (!(await hasCompletedLatestTurn(threadId))) {
        waitingForCompletion.add(threadId);
        publishThreadChanged(threadId);
        return { started: false, waiting: true };
      }
      void runManualReview(threadId);
      return { started: true, waiting: false };
    },

    async continueFinding({ threadId, reviewId }) {
      const reason = await continueWithFinding(threadId, reviewId, false);
      return { started: reason === "started", reason };
    },

    async setHostModel({ hostId, selection }) {
      if (selection === null) {
        db.prepare(`DELETE FROM advisor_host_models WHERE host_id = ?`).run(
          hostId,
        );
        return { ok: true } as const;
      }
      const options = await listHostModelOptions(hostId);
      const available = options.some(
        (option) =>
          option.providerId === selection.providerId &&
          option.model === selection.model &&
          (selection.reasoningLevel === "default" ||
            option.supportedReasoningLevels.includes(
              selection.reasoningLevel,
            )),
      );
      if (!available) {
        throw new Error(
          `Model ${selection.providerId}/${selection.model} is not available on this machine.`,
        );
      }
      db.prepare(
        `INSERT INTO advisor_host_models (
           host_id, provider_id, model, reasoning_level, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(host_id) DO UPDATE SET
           provider_id = excluded.provider_id,
           model = excluded.model,
           reasoning_level = excluded.reasoning_level,
           updated_at = excluded.updated_at`,
      ).run(
        hostId,
        selection.providerId,
        selection.model,
        selection.reasoningLevel,
        Date.now(),
      );
      return { ok: true } as const;
    },
  });

  bb.agents.registerTool({
    name: ADVISOR_TOOL,
    description:
      "Run an independent review-only model pass on this thread and return concrete issues before finalizing.",
    instructions:
      "For substantial coding work, call advisor_review exactly once after implementation and verification but before the final answer. Address concern/blocker feedback before completing.",
    experimental_statusLabels: {
      pending: "Consulting advisor",
      completed: "Consulted advisor",
    },
    parameters: z.object({
      focus: z
        .string()
        .max(4000)
        .default("")
        .describe("What changed, what was verified, and any uncertainty the advisor should examine"),
    }),
    async execute({ focus }, context) {
      // The gate is mandatory, so it must always answer. An unexpected throw
      // would surface as a raw tool error rather than the explicit
      // "unavailable, and this is not approval" contract the agent relies on.
      let outcome: AdvisorOutcome;
      try {
        const preFinalFocus =
          "Pre-final tool review. The primary agent has not written its final answer yet; that is expected and must never be reported as a missing-answer finding. Review the completed work, evidence, and proposed answer described below.\n\n" +
          (focus || "No additional focus was supplied.");
        outcome = await reviewPrimaryThreadWithState(
          context.threadId,
          preFinalFocus,
          context.signal,
        );
      } catch (error) {
        outcome = {
          kind: "unavailable",
          reason: `the review failed unexpectedly (${describeError(error)})`,
        };
      }
      // The threshold is a product setting, not an auto-review setting: a user
      // who asked to hear only about blockers should not get nits mid-turn.
      if (outcome.kind === "reviewed" && chainIsResolved(outcome.row)) {
        markReviewDelivered(outcome.row.id, false);
        publishThreadChanged(context.threadId);
        toolReviewedThreads.add(context.threadId);
        return "Advisor pass: no unresolved findings.";
      }
      if (
        outcome.kind === "reviewed" &&
        outcome.row.severity !== "pass" &&
        !meetsThreshold(outcome.row.severity, currentSettings.severityThreshold)
      ) {
        markReviewDelivered(outcome.row.id, false);
        publishThreadChanged(context.threadId);
        toolReviewedThreads.add(context.threadId);
        return `Advisor pass: no findings at or above your "${currentSettings.severityThreshold}" threshold.`;
      }
      if (outcome.kind === "reviewed") {
        // Only this exact result reached the agent. Older queued findings stay
        // pending until they are actually injected or explicitly settled.
        markReviewDelivered(
          outcome.row.id,
          outcome.row.severity !== "pass",
        );
        publishThreadChanged(context.threadId);
        toolReviewedThreads.add(context.threadId);
      }
      return formatOutcome(outcome);
    },
  });

  bb.agents.configure((context) => {
    const isPluginOwnedThread = context.origin.pluginId !== null;
    if (isPluginOwnedThread || !currentSettings.enabled) {
      return { tools: [], skills: [] };
    }

    rememberContext(context);
    const pending = consumePending(context.thread.id);
    const carriedAdvice =
      pending.length > 0
        ? `\n\nA late independent review queue from previous turns contains:\n${pending
            .map((row) => formatReview(rowToReview(row)))
            .join("\n\n")}\nAddress every finding above before proceeding.`
        : "";
    return {
      tools: [ADVISOR_TOOL],
      skills: [],
      instructions:
        `Advisor policy: for substantial coding, debugging, refactoring, or configuration work, you MUST call ${ADVISOR_TOOL} exactly once after your implementation and checks, before your final answer. If it reports a concern or blocker, correct the work and re-verify before completing. Do not call it for greetings or simple factual conversation.${carriedAdvice}`,
    };
  });

  async function resolvePrimaryContext(primaryThreadId: string): Promise<PrimaryContext> {
    const cached = primaryContexts.get(primaryThreadId);
    if (cached) return cached;

    const [thread, defaults] = await Promise.all([
      bb.sdk.threads.get({ threadId: primaryThreadId }),
      bb.sdk.threads.defaultExecutionOptions({ threadId: primaryThreadId }),
    ]);
    if (!thread.environmentId) {
      throw new Error("The primary thread has no ready environment for advisor review.");
    }
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    const context = {
      projectId: thread.projectId,
      providerId: thread.providerId,
      model: defaults?.model ?? "",
      environmentId: thread.environmentId,
      hostId: environment.hostId,
    };
    if (!context.model) {
      throw new Error("Could not resolve the primary thread model for advisor review.");
    }
    primaryContexts.set(primaryThreadId, context);
    return context;
  }

  /**
   * Whether a provider can host a reviewer in this environment. "unknown" when
   * the catalog could not be read — the spawn itself is then the check, so a
   * transient catalog outage does not disable reviews.
   */
  async function providerCanReview(
    environmentId: string,
    providerId: string,
  ): Promise<
    | { kind: "supported"; permissionMode: AdvisorPermissionMode }
    | "unsupported"
    | "unknown"
  > {
    try {
      const catalog = await bb.sdk.providers.models({
        environmentId,
        providerId,
      });
      const provider = catalog.providers.find(
        (candidate) => candidate.id === providerId,
      );
      if (!provider) return "unknown";
      if (!provider.available) return "unsupported";
      const permissionMode = narrowestReviewMode(
        provider.capabilities.supportedPermissionModes,
      );
      return permissionMode === null
        ? "unsupported"
        : { kind: "supported", permissionMode };
    } catch (error) {
      bb.log.warn(
        `Could not read the ${providerId} catalog for advisor review: ${String(error)}`,
      );
      return "unknown";
    }
  }

  async function followPrimaryModel(
    context: PrimaryContext,
  ): Promise<AdvisorModelResolution> {
    const capability = await providerCanReview(
      context.environmentId,
      context.providerId,
    );
    if (capability === "unsupported") {
      return {
        kind: "unavailable",
        reason: `this thread runs on ${context.providerId}, which cannot host a reviewer in ${ADVISOR_PERMISSION_MODE_LABEL}, and this machine has no advisor model configured (set one in Settings → Extensions → Advisor)`,
      };
    }
    return {
      kind: "ready",
      providerId: context.providerId,
      model: context.model,
      reasoningLevel:
        currentSettings.advisorReasoning === "inherit"
          ? null
          : currentSettings.advisorReasoning,
      // "unknown" means the catalog could not be read. Probing narrowest-first
      // keeps a transient outage from disabling reviews without letting it
      // silently hand the reviewer a wider mode than the host would have.
      permissionModeCandidates:
        capability === "unknown"
          ? ADVISOR_PERMISSION_MODE_PREFERENCE
          : [capability.permissionMode],
    };
  }

  async function resolveAdvisorModel(
    context: PrimaryContext,
  ): Promise<AdvisorModelResolution> {
    const selection = readHostModel(context.hostId);
    if (!selection) {
      return followPrimaryModel(context);
    }
    try {
      const catalog = await bb.sdk.providers.models({
        environmentId: context.environmentId,
        providerId: selection.providerId,
      });
      const selectedProvider = catalog.providers.find(
        (provider) => provider.id === selection.providerId,
      );
      const permissionMode =
        selectedProvider?.available === true
          ? narrowestReviewMode(
              selectedProvider.capabilities.supportedPermissionModes,
            )
          : null;
      const selectedModel = catalog.models.find(
        (model) => model.model === selection.model,
      );
      const reasoningLevel =
        selection.reasoningLevel === "default"
          ? selectedModel?.defaultReasoningEffort
          : selection.reasoningLevel;
      const reasoningAvailable = selectedModel?.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === reasoningLevel,
      );
      if (
        catalog.modelLoadError === null &&
        permissionMode !== null &&
        selectedModel &&
        reasoningLevel &&
        reasoningAvailable
      ) {
        return {
          kind: "ready",
          providerId: selection.providerId,
          model: selection.model,
          reasoningLevel,
          permissionModeCandidates: [permissionMode],
        };
      }
    } catch (error) {
      bb.log.warn(
        `Could not validate advisor model on host ${context.hostId}: ${String(error)}`,
      );
    }
    bb.log.warn(
      `Advisor configuration ${selection.providerId}/${selection.model}/${selection.reasoningLevel} is unavailable on host ${context.hostId}; following the primary model for this review.`,
    );
    return followPrimaryModel(context);
  }

  async function getOrCreateAdvisorThread(
    primaryThreadId: string,
    prompt: string,
    context: PrimaryContext,
    resolved: Extract<AdvisorModelResolution, { kind: "ready" }>,
  ): Promise<{ id: string; startedWithPrompt: boolean }> {
    const { providerId, model } = resolved;
    const reasoningLevel = resolved.reasoningLevel ?? undefined;
    const reasoningKey = reasoningLevel ?? "default";
    const stored = sessionRowSchema.safeParse(
      db
        .prepare(
          `SELECT advisor_thread_id, provider_id, model, reasoning_level,
                  environment_id, permission_mode
           FROM advisor_sessions WHERE primary_thread_id = ?`,
        )
        .get(primaryThreadId),
    );

    // When the catalog could not be read, a mode this host previously accepted
    // is the best evidence available, so it is tried first — the probe then
    // costs nothing on the common path and still never widens on its own.
    const previouslyAccepted = stored.success
      ? stored.data.permission_mode
      : "";
    const candidates = [
      ...(resolved.permissionModeCandidates.length > 1 &&
      resolved.permissionModeCandidates.includes(previouslyAccepted)
        ? [previouslyAccepted]
        : []),
      ...resolved.permissionModeCandidates,
    ].filter((mode, index, all) => all.indexOf(mode) === index);

    // A reviewer is pinned to the environment it was spawned into, so a session
    // from a different environment must not be reused: it would inspect the
    // wrong checkout even though the reviewer itself is read-only.
    if (
      stored.success &&
      stored.data.provider_id === providerId &&
      stored.data.model === model &&
      stored.data.reasoning_level === reasoningKey &&
      stored.data.environment_id === context.environmentId &&
      // A session spawned under a wider mode must not survive a bb upgrade
      // that made a narrower one available: reusing it would quietly keep the
      // reviewer's write access.
      stored.data.permission_mode === candidates[0]
    ) {
      try {
        const thread = await bb.sdk.threads.get({
          threadId: stored.data.advisor_thread_id,
        });
        if (!thread.archivedAt && !thread.deletedAt) {
          return { id: thread.id, startedWithPrompt: false };
        }
      } catch (error) {
        bb.log.warn(`Recreating missing advisor thread: ${String(error)}`);
      }
    }

    const primary = await bb.sdk.threads.get({ threadId: primaryThreadId });
    let advisor: Awaited<ReturnType<typeof bb.sdk.threads.spawn>> | null = null;
    let permissionMode = candidates[0]!;
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        advisor = await bb.sdk.threads.spawn({
          projectId: context.projectId,
          providerId,
          model,
          ...(reasoningLevel ? { reasoningLevel } : {}),
          // The host validates this. When the catalog was unreadable the
          // candidate may be a mode this bb build's types do not know, which is
          // exactly the boundary a cast belongs at: a refusal falls through to
          // the next, wider candidate rather than being assumed up front.
          permissionMode: candidate as AdvisorPermissionMode,
          environment: { type: "reuse", environmentId: context.environmentId },
          visibility: "hidden",
          title: `${ADVISOR_TITLE_PREFIX}${primary.title ?? primary.titleFallback ?? primaryThreadId}`,
          prompt,
        });
        permissionMode = candidate;
        break;
      } catch (error) {
        lastError = error;
        bb.log.warn(
          `Reviewer spawn refused in ${candidate} mode: ${String(error)}`,
        );
      }
    }
    if (!advisor) throw lastError;
    const now = Date.now();
    db.prepare(
      `INSERT INTO advisor_sessions (
         primary_thread_id, advisor_thread_id, provider_id, model,
         reasoning_level, environment_id, permission_mode, created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(primary_thread_id) DO UPDATE SET
         advisor_thread_id = excluded.advisor_thread_id,
         provider_id = excluded.provider_id,
         model = excluded.model,
         reasoning_level = excluded.reasoning_level,
         environment_id = excluded.environment_id,
         permission_mode = excluded.permission_mode,
         updated_at = excluded.updated_at`,
    ).run(
      primaryThreadId,
      advisor.id,
      providerId,
      model,
      reasoningKey,
      context.environmentId,
      permissionMode,
      now,
      now,
    );
    return { id: advisor.id, startedWithPrompt: true };
  }

  /** Open, unsettled, non-pass chains — what the advisor may close. */
  function readOpenFindings(primaryThreadId: string) {
    return collapseChains(readThreadRows(primaryThreadId)).filter(
      (chain) =>
        chain.severity !== "pass" &&
        chain.resolvedAt === null &&
        chain.closedAt === null &&
        chain.findingKey.length > 0,
    );
  }

  /**
   * Close the chains the advisor named. Only keys that are currently open on
   * this thread are honoured, and never the finding being raised in the same
   * result — an advisor cannot both raise and close a defect in one breath.
   */
  function applyAdvisorClosures(
    primaryThreadId: string,
    resolvedKeys: readonly string[],
    raisedKey: string,
    sourceSeq: number,
  ): void {
    if (resolvedKeys.length === 0) return;
    const closable = new Map(
      readOpenFindings(primaryThreadId).map((chain) => [
        chain.findingKey,
        chain.chainId,
      ]),
    );
    const now = Date.now();
    for (const key of resolvedKeys) {
      if (key === raisedKey) continue;
      const chainId = closable.get(key);
      if (chainId === undefined) continue;
      db.prepare(
        `UPDATE advisor_reviews SET closed_at = ?, closed_seq = ?
         WHERE primary_thread_id = ? AND id = ? AND resolved_at IS NULL`,
      ).run(now, sourceSeq, primaryThreadId, chainId);
      db.prepare(
        `UPDATE advisor_reviews SET delivered_at = ?
         WHERE primary_thread_id = ? AND delivered_at IS NULL
           AND (id = ? OR repeat_of = ?)`,
      ).run(now, primaryThreadId, chainId, chainId);
    }
  }

  async function runReview(
    primaryThreadId: string,
    focus: string,
    timeline: { rows: readonly object[]; maxSeq: number },
    signal: AbortSignal | undefined,
  ): Promise<AdvisorOutcome> {
    // Every non-review exit goes through here, so a failure is always recorded
    // as an incident and can never be silently absent from the panel.
    const unavailable = (reason: string): AdvisorOutcome => {
      recordIncident(primaryThreadId, timeline.maxSeq, reason);
      return { kind: "unavailable", reason };
    };

    let context: PrimaryContext;
    let resolved: Extract<AdvisorModelResolution, { kind: "ready" }>;
    try {
      context = await resolvePrimaryContext(primaryThreadId);
      const model = await resolveAdvisorModel(context);
      if (model.kind === "unavailable") return unavailable(model.reason);
      resolved = model;
    } catch (error) {
      return unavailable(
        `the review could not be prepared (${describeError(error)})`,
      );
    }
    const openFindings = readOpenFindings(primaryThreadId);
    const prompt = buildAdvisorPrompt({
      primaryThreadId,
      sourceSeq: timeline.maxSeq,
      transcript: formatTimelineRows(
        timeline.rows,
        currentSettings.transcriptSize,
      ),
      focus,
      watchdogFile: currentSettings.watchdogFile.trim() || "WATCHDOG.md",
      timeoutSeconds: currentSettings.timeoutSeconds,
      openFindings: openFindings
        .slice(0, MAX_PROMPTED_OPEN_FINDINGS)
        .map((finding) => ({
          key: finding.findingKey,
          summary: finding.summary,
        })),
      openFindingsTruncated: openFindings.length > MAX_PROMPTED_OPEN_FINDINGS,
    });
    let advisor: { id: string; startedWithPrompt: boolean };
    try {
      advisor = await getOrCreateAdvisorThread(
        primaryThreadId,
        prompt,
        context,
        resolved,
      );
      if (!advisor.startedWithPrompt) {
        await bb.sdk.threads.send({
          threadId: advisor.id,
          mode: "start",
          input: [{ type: "text", text: prompt, mentions: [] }],
        });
      }
    } catch (error) {
      return unavailable(
        `the reviewer thread could not be started (${describeError(error)})`,
      );
    }

    const advisorThreadId = advisor.id;
    const stopAdvisor = (): void => {
      void bb.sdk.threads
        .stop({ threadId: advisorThreadId })
        .catch(() => undefined);
    };
    if (signal?.aborted) {
      stopAdvisor();
      return unavailable(CANCELLED_REASON);
    }
    const onAbort = (): void => stopAdvisor();
    signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutMs = currentSettings.timeoutSeconds * 1000;
    const { finalizeAfterMs } = reviewBudget(currentSettings.timeoutSeconds);
    const finalizeTimer = setTimeout(() => {
      void bb.sdk.threads
        .send({
          threadId: advisorThreadId,
          mode: "steer-if-active",
          input: [
            {
              type: "text",
              visibility: "agent-only",
              text: "FINALIZE NOW. Stop all inspection and return the required ADVISOR_RESULT block immediately using the evidence already collected. Do not send progress text.",
              mentions: [],
            },
          ],
        })
        .catch((error) => {
          bb.log.warn(
            `Could not send the advisor finalization deadline: ${describeError(error)}`,
          );
        });
    }, finalizeAfterMs);
    try {
      await bb.sdk.threads.wait({
        threadId: advisorThreadId,
        status: "idle",
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      stopAdvisor();
      // A timeout is self-describing; the exception name and the reviewer's
      // thread id are developer detail that ends up verbatim in the panel.
      bb.log.warn(`Advisor review timed out: ${describeError(error)}`);
      return unavailable(
        signal?.aborted
          ? CANCELLED_REASON
          : `the review did not finish within ${currentSettings.timeoutSeconds}s. Raise "Review timeout" in Settings → Extensions → Advisor if reviews need longer`,
      );
    } finally {
      clearTimeout(finalizeTimer);
      signal?.removeEventListener("abort", onAbort);
    }
    let output: string | null;
    try {
      ({ output } = await bb.sdk.threads.output({
        threadId: advisorThreadId,
      }));
    } catch (error) {
      return unavailable(
        `the review could not be read back (${describeError(error)})`,
      );
    }
    if (!output) {
      return unavailable("the reviewer finished without returning a review");
    }

    // Repeated advice is recorded as a repeat, never softened: identical advice
    // means the primary agent was already told and has not resolved it, which
    // is the case where downgrading to a pass is most harmful.
    const review = parseAdvisorOutput(output);
    if (!review) {
      // Prose with no verdict is not a finding. Fabricating a `concern` here
      // would hand the agent work to do based on nothing.
      return unavailable(
        `the reviewer's reply carried no verdict (${output.trim().slice(0, 160)})`,
      );
    }
    const normalized = normalizeAdvice(review);
    // Prefer the advisor's own stable key: it survives rewording and a changed
    // severity, which is exactly when a chain matters. Text equality is only
    // the fallback, and there it must clear a length floor — a terse generic
    // line would otherwise merge unrelated findings and hand one an inherited
    // severity it never earned.
    const findingKey = review.key === "none" ? "" : review.key;
    const matchChainRoot = (sql: string, value: string) => {
      const parsed = chainRootRowSchema.safeParse(
        db.prepare(sql).get(primaryThreadId, value),
      );
      return parsed.success ? parsed.data : null;
    };
    const root =
      (findingKey.length > 0
        ? matchChainRoot(
            `SELECT id, severity, resolved_at, resolved_reason, closed_at,
                    closed_seq, decision, auto_continued_at
             FROM advisor_reviews
             WHERE primary_thread_id = ? AND finding_key = ?
             ORDER BY source_seq, id LIMIT 1`,
            findingKey,
          )
        : null) ??
      // Text fallback, used both for keyless output and for a keyed finding
      // whose chain predates keys. Restricting this to keyless rows would
      // permanently split a legacy chain, letting an old blocker soften the
      // first time it is re-emitted with a key.
      (normalized.length >= MIN_CHAINABLE_ADVICE_LENGTH
        ? matchChainRoot(
            `SELECT id, severity, resolved_at, resolved_reason, closed_at,
                    closed_seq, decision, auto_continued_at
             FROM advisor_reviews
             WHERE primary_thread_id = ? AND normalized = ?
             ORDER BY source_seq, id LIMIT 1`,
            normalized,
          )
        : null);
    const repeatOf = root ? root.id : null;
    // `normalizeAdvice` ignores severity, so the same advice restated as a nit
    // would otherwise be persisted as a nit and slip under the pending-advice
    // threshold. A repeat can escalate but never soften.
    const severity = root
      ? strongerSeverity(root.severity, review.severity)
      : review.severity;
    const result = db
      .prepare(
        `INSERT INTO advisor_reviews (
           primary_thread_id, source_seq, severity, summary, details,
           normalized, created_at, delivered_at, repeat_of,
           provider_id, model, reasoning_level, advisor_thread_id,
           finding_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
         RETURNING ${REVIEW_COLUMNS}`,
      )
      .get(
        primaryThreadId,
        timeline.maxSeq,
        severity,
        review.summary,
        review.details,
        normalized,
        Date.now(),
        repeatOf,
        resolved.providerId,
        resolved.model,
        resolved.reasoningLevel ?? "default",
        advisorThreadId,
        findingKey,
      );
    // A finding the advisor previously closed has come back. That is a
    // regression, not a closure, so the chain reopens. A chain the USER
    // settled is deliberately left alone: their decision is authoritative and
    // a restatement must not drag it back open.
    if (root !== null && root.closed_at !== null && root.resolved_at === null) {
      db.prepare(
        `UPDATE advisor_reviews
         SET closed_at = NULL, closed_seq = NULL, auto_continued_at = NULL
         WHERE primary_thread_id = ? AND id = ?`,
      ).run(primaryThreadId, root.id);
    }
    applyAdvisorClosures(
      primaryThreadId,
      review.resolvedKeys,
      findingKey,
      timeline.maxSeq,
    );
    publishThreadChanged(primaryThreadId);
    return { kind: "reviewed", row: reviewRowSchema.parse(result) };
  }

  /**
   * In-flight reviews are keyed by thread AND timeline sequence: a review of an
   * earlier turn must never be handed to a caller asking about a later one. A
   * post-turn review can still be running when the next turn calls the tool,
   * and thread-only keying would return the earlier turn's verdict as though it
   * had examined the new work.
   */
  async function reviewPrimaryThread(
    primaryThreadId: string,
    focus: string,
    signal?: AbortSignal,
  ): Promise<AdvisorOutcome> {
    let timeline: { rows: readonly object[]; maxSeq: number };
    try {
      timeline = await bb.sdk.threads.timeline({
        threadId: primaryThreadId,
        includeNestedRows: "true",
        segmentLimit: "12",
      });
    } catch (error) {
      // The turn under review is unknown here, so the incident is filed at
      // sequence -1 rather than being dropped.
      const reason = `the thread transcript could not be read (${describeError(error)})`;
      recordIncident(primaryThreadId, -1, reason);
      return { kind: "unavailable", reason };
    }
    const existing = readReview(primaryThreadId, timeline.maxSeq);
    if (existing) return { kind: "reviewed", row: existing };

    const key = `${primaryThreadId} ${timeline.maxSeq}`;
    const inflight = inFlight.get(key);
    // Callers sharing a key are reviewing identical work, so they share the
    // outcome. Only the first caller's signal cancels it; a cancelled shared
    // review resolves `unavailable`, which never reads as approval.
    if (inflight) return inflight;
    const promise = runReview(primaryThreadId, focus, timeline, signal).finally(
      () => {
        inFlight.delete(key);
      },
    );
    inFlight.set(key, promise);
    return promise;
  }

  async function reviewPrimaryThreadWithState(
    primaryThreadId: string,
    focus: string,
    signal?: AbortSignal,
  ): Promise<AdvisorOutcome> {
    beginReview(primaryThreadId);
    try {
      return await reviewPrimaryThread(primaryThreadId, focus, signal);
    } finally {
      endReview(primaryThreadId);
    }
  }

  async function surfacePendingFinding(
    primaryThreadId: string,
    outcome: AdvisorOutcome,
  ): Promise<void> {
    if (outcome.kind === "unavailable") return;
    const { row } = outcome;
    if (
      row.severity === "pass" ||
      !meetsThreshold(row.severity, currentSettings.severityThreshold) ||
      chainIsResolved(row)
    ) {
      return;
    }
    publishThreadChanged(primaryThreadId);
    if (currentSettings.autoContinue) {
      try {
        await continueWithFinding(primaryThreadId, row.id, true);
      } catch (error) {
        bb.log.error(
          `Automatic Advisor continuation failed for ${primaryThreadId}: ${describeError(error)}`,
        );
      }
    }
  }

  async function runManualReview(primaryThreadId: string): Promise<void> {
    try {
      const outcome = await reviewPrimaryThreadWithState(
        primaryThreadId,
        "Manual review requested by the user. Review the latest completed work.",
      );
      if (outcome.kind === "unavailable") {
        bb.log.warn(
          `Manual advisor review unavailable for ${primaryThreadId}: ${outcome.reason}.`,
        );
        return;
      }
      await surfacePendingFinding(primaryThreadId, outcome);
    } catch (error) {
      bb.log.error(
        `Manual advisor review failed for ${primaryThreadId}: ${describeError(error)}`,
      );
    }
  }

  async function cancelWaitingReview(
    primaryThreadId: string,
    reason: string,
  ): Promise<boolean> {
    if (!waitingForCompletion.delete(primaryThreadId)) return false;
    let sourceSeq =
      [...readThreadRows(primaryThreadId)].sort(byTurnDescending)[0]
        ?.source_seq ?? -1;
    try {
      const timeline = await bb.sdk.threads.timeline({
        threadId: primaryThreadId,
        includeNestedRows: "true",
        segmentLimit: "2",
      });
      sourceSeq = timeline.maxSeq;
    } catch {
      // The incident still needs to replace the stale waiting state. The most
      // recent known review sequence is the safest fallback available.
    }
    recordIncident(primaryThreadId, sourceSeq, reason);
    return true;
  }

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    // Always consume the one-turn suppression flag, even when settings or the
    // event payload make this idle transition ineligible for post-turn review.
    const toolReviewed = toolReviewedThreads.delete(thread.id);
    if (waitingForCompletion.has(thread.id)) {
      if (lastAssistantText) {
        waitingForCompletion.delete(thread.id);
        publishThreadChanged(thread.id);
        await runManualReview(thread.id);
      } else {
        await cancelWaitingReview(
          thread.id,
          "the requested review was cancelled because the turn ended without a completed public answer. Use Review now to retry",
        );
      }
      return;
    }
    if (toolReviewed) return;
    if (
      !currentSettings.enabled ||
      !currentSettings.autoReview ||
      !lastAssistantText ||
      thread.visibility === "hidden" ||
      // Matches the gate in agents.configure: a plugin-owned thread never gets
      // the advisor tool or instructions, so it can never consume the advice a
      // post-turn review would leave pending for it.
      thread.originPluginId !== null
    ) {
      return;
    }
    try {
      const outcome = await reviewPrimaryThreadWithState(
        thread.id,
        "Post-turn review. Verify the completed answer and the work it claims.",
      );
      if (outcome.kind === "unavailable") {
        bb.log.warn(
          `Post-turn advisor review skipped for ${thread.id}: ${outcome.reason}.`,
        );
        return;
      }
      await surfacePendingFinding(thread.id, outcome);
    } catch (error) {
      bb.log.error(
        `Post-turn advisor review failed for ${thread.id}: ${describeError(error)}`,
      );
    }
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    toolReviewedThreads.delete(thread.id);
    await cancelWaitingReview(
      thread.id,
      `the requested review was cancelled because the primary turn failed before producing a completed public answer${error ? ` (${error})` : ""}. Use Review now to retry`,
    );
  });

  /**
   * A primary thread that is gone takes its advisor state with it. Without
   * this, every archived thread leaves a hidden reviewer thread, a session row,
   * and its whole review history behind forever.
   */
  async function retireThread(
    thread: { id: string; originPluginId: string | null },
    permanent: boolean,
  ): Promise<void> {
    if (thread.originPluginId === PLUGIN_ID) return;
    const advisorThreadId = readAdvisorThreadId(thread.id);
    primaryContexts.delete(thread.id);
    waitingForCompletion.delete(thread.id);
    toolReviewedThreads.delete(thread.id);

    if (permanent) {
      // Only a real deletion destroys history. Archiving is reversible in bb,
      // so discarding a thread's reviews on archive would lose them for good
      // the moment the user unarchived it.
      db.prepare(`DELETE FROM advisor_reviews WHERE primary_thread_id = ?`).run(
        thread.id,
      );
      db.prepare(
        `DELETE FROM advisor_incidents WHERE primary_thread_id = ?`,
      ).run(thread.id);
      db.prepare(`DELETE FROM advisor_sessions WHERE primary_thread_id = ?`).run(
        thread.id,
      );
    }

    // The hidden reviewer is archived either way: it is an appliance of the
    // primary thread, and unarchiving the primary respawns one on next review.
    if (advisorThreadId) {
      await bb.sdk.threads
        .archive({ threadId: advisorThreadId })
        .catch(() => undefined);
    }
  }

  bb.events.on("thread.deleted", ({ thread }) => retireThread(thread, true));
  bb.events.on("thread.archived", ({ thread }) => retireThread(thread, false));

  bb.cli.register({
    name: "advisor",
    summary: "Inspect advisor configuration and review history",
    commands: [
      {
        name: "status",
        summary: "Show advisor status for the current or given thread",
        usage: "bb advisor status [thread-id]",
      },
      {
        name: "reviews",
        summary: "Show recent advisor reviews",
        usage: "bb advisor reviews [thread-id]",
      },
    ],
    run(argv, cliContext) {
      const [command = "status", explicitThreadId] = argv;
      const threadId = explicitThreadId ?? cliContext.threadId;
      if (command === "status") {
        const target = threadId
          ? `\nThread: ${threadId}\nReview lifecycle: ${reviewLifecycle(threadId)}`
          : "";
        const selections = db
          .prepare(
            `SELECT host_id, provider_id, model, reasoning_level
             FROM advisor_host_models ORDER BY host_id`,
          )
          .all()
          .flatMap((row) => {
            const parsed = hostModelRowSchema.safeParse(row);
            return parsed.success ? [parsed.data] : [];
          });
        const modelStatus =
          selections.length === 0
            ? "follow primary on every machine"
            : selections
                .map(
                  (selection) =>
                    `${selection.host_id}=${selection.provider_id}/${selection.model}@${selection.reasoning_level}`,
                )
                .join(", ");
        return {
          exitCode: 0,
          stdout: `Advisor: ${currentSettings.enabled ? "enabled" : "disabled"}\nAuto review: ${currentSettings.autoReview ? "enabled" : "disabled"}\nAuto continue: ${currentSettings.autoContinue ? "enabled" : "disabled"}\nMachine models: ${modelStatus}${target}`,
        };
      }
      if (command === "reviews") {
        if (!threadId) {
          return { exitCode: 1, stderr: "Pass a thread id or run from a bb thread." };
        }
        const rows = db
          .prepare(
            `SELECT ${REVIEW_COLUMNS}
             FROM advisor_reviews WHERE primary_thread_id = ?
             ORDER BY id DESC LIMIT 20`,
          )
          .all(threadId)
          .flatMap((row) => {
            const parsed = reviewRowSchema.safeParse(row);
            return parsed.success ? [parsed.data] : [];
          });
        return {
          exitCode: 0,
          stdout:
            rows.length === 0
              ? `No advisor reviews for ${threadId}.`
              : rows
                  .map(
                    (row) =>
                      `[${row.severity}] seq ${row.source_seq}: ${row.summary}${
                        row.repeat_of === null ? "" : ` (repeat of #${row.repeat_of})`
                      }`,
                  )
                  .join("\n"),
        };
      }
      return {
        exitCode: 1,
        stderr: "Usage: bb advisor status [thread-id]\n       bb advisor reviews [thread-id]",
      };
    },
  });
}
