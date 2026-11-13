import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type LedgerDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

export const REVIEW_TRIGGERS = ["tool", "post-turn", "manual"] as const;
export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];
export type RunOutcome = "reviewed" | "unavailable" | "skipped";
export type UsageStatus = "pending" | "recorded" | "unknown" | "none";

export const LEDGER_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS advisor_review_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    primary_thread_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    outcome TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    review_id INTEGER,
    severity TEXT,
    source_seq INTEGER NOT NULL,
    evidence_mode TEXT NOT NULL DEFAULT '',
    evidence_from_seq INTEGER,
    evidence_to_seq INTEGER,
    prompt_chars INTEGER,
    carried_turns INTEGER NOT NULL DEFAULT 0,
    advisor_thread_id TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    reasoning_level TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    elapsed_ms INTEGER,
    usage_status TEXT NOT NULL DEFAULT 'none',
    input_tokens INTEGER,
    cached_input_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    total_tokens INTEGER,
    cost_amount REAL,
    cost_currency TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS advisor_review_runs_thread_idx
    ON advisor_review_runs(primary_thread_id, id)`,
  `CREATE INDEX IF NOT EXISTS advisor_review_runs_created_idx
    ON advisor_review_runs(created_at)`,
];

const tokenTotalsSchema = z.object({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheReadInputTokens: z.number().optional(),
  cacheWriteInputTokens: z.number().optional(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
  totalTokens: z.number(),
});

export type TokenTotals = z.infer<typeof tokenTotalsSchema>;

export interface UsageSnapshot {
  seq: number;
  providerThreadId: string;
  total: TokenTotals;
}

export interface CostSnapshot {
  seq: number;
  providerThreadId: string;
  amount: number;
  currency: string;
}

const tokenEventSchema = z.object({
  seq: z.number(),
  data: z.object({
    providerThreadId: z.string(),
    tokenUsage: z.object({ total: tokenTotalsSchema }),
  }),
});

const costEventSchema = z.object({
  seq: z.number(),
  data: z.object({
    providerThreadId: z.string(),
    contextWindowUsage: z.object({
      cost: z.object({ amount: z.number(), currency: z.string() }).optional(),
    }),
  }),
});

export function parseUsageSnapshot(event: unknown): UsageSnapshot | null {
  const parsed = tokenEventSchema.safeParse(event);
  if (!parsed.success) return null;
  return {
    seq: parsed.data.seq,
    providerThreadId: parsed.data.data.providerThreadId,
    total: parsed.data.data.tokenUsage.total,
  };
}

export function parseCostSnapshot(event: unknown): CostSnapshot | null {
  const parsed = costEventSchema.safeParse(event);
  const cost = parsed.success ? parsed.data.data.contextWindowUsage.cost : undefined;
  if (!parsed.success || cost === undefined) return null;
  return {
    seq: parsed.data.seq,
    providerThreadId: parsed.data.data.providerThreadId,
    amount: cost.amount,
    currency: cost.currency,
  };
}

export interface ReviewUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

function sameSession<T extends { seq: number; providerThreadId: string }>(
  before: T | null,
  after: T,
): boolean {
  return before !== null && before.providerThreadId === after.providerThreadId;
}

export function usageBetween(
  before: UsageSnapshot | null,
  after: UsageSnapshot | null,
): ReviewUsage | null {
  if (after === null) return null;
  if (before !== null && after.seq <= before.seq) return null;
  const delta =
    sameSession(before, after) && after.total.totalTokens >= before!.total.totalTokens
      ? before!.total
      : null;
  const minus = (next: number | undefined, previous: number | undefined) =>
    next === undefined ? null : Math.max(0, next - (delta ? (previous ?? 0) : 0));
  return {
    inputTokens: minus(after.total.inputTokens, delta?.inputTokens)!,
    cachedInputTokens: minus(after.total.cachedInputTokens, delta?.cachedInputTokens)!,
    cacheReadTokens: minus(after.total.cacheReadInputTokens, delta?.cacheReadInputTokens),
    cacheWriteTokens: minus(after.total.cacheWriteInputTokens, delta?.cacheWriteInputTokens),
    outputTokens: minus(after.total.outputTokens, delta?.outputTokens)!,
    reasoningTokens: minus(after.total.reasoningOutputTokens, delta?.reasoningOutputTokens)!,
    totalTokens: minus(after.total.totalTokens, delta?.totalTokens)!,
  };
}

export function costBetween(
  before: CostSnapshot | null,
  after: CostSnapshot | null,
): { amount: number; currency: string } | null {
  if (after === null) return null;
  if (before !== null && after.seq <= before.seq) return null;
  if (
    sameSession(before, after) &&
    before!.currency === after.currency &&
    after.amount >= before!.amount
  ) {
    return { amount: after.amount - before!.amount, currency: after.currency };
  }
  return { amount: after.amount, currency: after.currency };
}

const ledgerRowSchema = z.object({
  id: z.number().int(),
  primary_thread_id: z.string(),
  trigger: z.string(),
  outcome: z.enum(["reviewed", "unavailable", "skipped"]),
  reason: z.string(),
  review_id: z.number().int().nullable(),
  severity: z.string().nullable(),
  source_seq: z.number().int(),
  evidence_mode: z.string(),
  evidence_from_seq: z.number().int().nullable(),
  evidence_to_seq: z.number().int().nullable(),
  prompt_chars: z.number().int().nullable(),
  carried_turns: z.number().int(),
  advisor_thread_id: z.string(),
  provider_id: z.string(),
  model: z.string(),
  reasoning_level: z.string(),
  started_at: z.number(),
  finished_at: z.number().nullable(),
  elapsed_ms: z.number().nullable(),
  usage_status: z.enum(["pending", "recorded", "unknown", "none"]),
  input_tokens: z.number().nullable(),
  cached_input_tokens: z.number().nullable(),
  cache_read_tokens: z.number().nullable(),
  cache_write_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  reasoning_tokens: z.number().nullable(),
  total_tokens: z.number().nullable(),
  cost_amount: z.number().nullable(),
  cost_currency: z.string().nullable(),
  created_at: z.number(),
});

export type LedgerRow = z.infer<typeof ledgerRowSchema>;

export const ledgerEntrySchema = z.object({
  id: z.number().int(),
  threadId: z.string(),
  trigger: z.string(),
  outcome: z.enum(["reviewed", "unavailable", "skipped"]),
  reason: z.string(),
  reviewId: z.number().int().nullable(),
  severity: z.string().nullable(),
  sourceSeq: z.number().int(),
  evidenceMode: z.string(),
  evidenceFromSeq: z.number().int().nullable(),
  evidenceToSeq: z.number().int().nullable(),
  promptChars: z.number().int().nullable(),
  carriedTurns: z.number().int(),
  advisorThreadId: z.string(),
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  elapsedMs: z.number().nullable(),
  usageStatus: z.enum(["pending", "recorded", "unknown", "none"]),
  inputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costAmount: z.number().nullable(),
  costCurrency: z.string().nullable(),
});

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

function toEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    threadId: row.primary_thread_id,
    trigger: row.trigger,
    outcome: row.outcome,
    reason: row.reason,
    reviewId: row.review_id,
    severity: row.severity,
    sourceSeq: row.source_seq,
    evidenceMode: row.evidence_mode,
    evidenceFromSeq: row.evidence_from_seq,
    evidenceToSeq: row.evidence_to_seq,
    promptChars: row.prompt_chars,
    carriedTurns: row.carried_turns,
    advisorThreadId: row.advisor_thread_id,
    providerId: row.provider_id,
    model: row.model,
    reasoningLevel: row.reasoning_level,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    elapsedMs: row.elapsed_ms,
    usageStatus: row.usage_status,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    costAmount: row.cost_amount,
    costCurrency: row.cost_currency,
  };
}

export interface RunStart {
  primaryThreadId: string;
  trigger: ReviewTrigger;
  sourceSeq: number;
  carriedTurns: number;
  startedAt: number;
}

export interface RunFinish {
  outcome: Exclude<RunOutcome, "skipped">;
  reason: string;
  reviewId: number | null;
  severity: string | null;
  evidenceMode: string;
  evidenceFromSeq: number | null;
  evidenceToSeq: number | null;
  promptChars: number | null;
  advisorThreadId: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
  finishedAt: number;
  usageStatus: UsageStatus;
}

export function createReviewLedger(db: LedgerDatabase) {
  return {
    start(run: RunStart): number {
      const row = db
        .prepare(
          `INSERT INTO advisor_review_runs (
             primary_thread_id, trigger, outcome, source_seq, carried_turns,
             started_at, usage_status, created_at
           ) VALUES (?, ?, 'unavailable', ?, ?, ?, 'pending', ?)
           RETURNING id`,
        )
        .get(
          run.primaryThreadId,
          run.trigger,
          run.sourceSeq,
          run.carriedTurns,
          run.startedAt,
          run.startedAt,
        );
      return z.object({ id: z.number().int() }).parse(row).id;
    },

    finish(id: number, run: RunFinish): void {
      db.prepare(
        `UPDATE advisor_review_runs SET
           outcome = ?, reason = ?, review_id = ?, severity = ?,
           evidence_mode = ?, evidence_from_seq = ?, evidence_to_seq = ?,
           prompt_chars = ?, advisor_thread_id = ?, provider_id = ?, model = ?,
           reasoning_level = ?, finished_at = ?, elapsed_ms = ? - started_at,
           usage_status = ?
         WHERE id = ?`,
      ).run(
        run.outcome,
        run.reason,
        run.reviewId,
        run.severity,
        run.evidenceMode,
        run.evidenceFromSeq,
        run.evidenceToSeq,
        run.promptChars,
        run.advisorThreadId,
        run.providerId,
        run.model,
        run.reasoningLevel,
        run.finishedAt,
        run.finishedAt,
        run.usageStatus,
        id,
      );
    },

    recordUsage(
      id: number,
      usage: ReviewUsage | null,
      cost: { amount: number; currency: string } | null,
    ): void {
      db.prepare(
        `UPDATE advisor_review_runs SET
           usage_status = ?, input_tokens = ?, cached_input_tokens = ?,
           cache_read_tokens = ?, cache_write_tokens = ?, output_tokens = ?,
           reasoning_tokens = ?, total_tokens = ?, cost_amount = ?,
           cost_currency = ?
         WHERE id = ?`,
      ).run(
        usage === null ? "unknown" : "recorded",
        usage?.inputTokens ?? null,
        usage?.cachedInputTokens ?? null,
        usage?.cacheReadTokens ?? null,
        usage?.cacheWriteTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.reasoningTokens ?? null,
        usage?.totalTokens ?? null,
        cost?.amount ?? null,
        cost?.currency ?? null,
        id,
      );
    },

    skipped(args: {
      primaryThreadId: string;
      sourceSeq: number;
      reason: string;
      at: number;
    }): void {
      db.prepare(
        `INSERT INTO advisor_review_runs (
           primary_thread_id, trigger, outcome, reason, source_seq,
           started_at, finished_at, elapsed_ms, usage_status, created_at
         ) VALUES (?, 'post-turn', 'skipped', ?, ?, ?, ?, 0, 'none', ?)`,
      ).run(
        args.primaryThreadId,
        args.reason,
        args.sourceSeq,
        args.at,
        args.at,
        args.at,
      );
    },

    list(args: { threadId?: string; since?: number; limit: number }): LedgerEntry[] {
      const where: string[] = [];
      const values: (string | number)[] = [];
      if (args.threadId !== undefined) {
        where.push("primary_thread_id = ?");
        values.push(args.threadId);
      }
      if (args.since !== undefined) {
        where.push("created_at >= ?");
        values.push(args.since);
      }
      return db
        .prepare(
          `SELECT * FROM advisor_review_runs
           ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY id DESC LIMIT ?`,
        )
        .all(...values, args.limit)
        .flatMap((row) => {
          const parsed = ledgerRowSchema.safeParse(row);
          return parsed.success ? [toEntry(parsed.data)] : [];
        });
    },

    forget(primaryThreadId: string): void {
      db.prepare(`DELETE FROM advisor_review_runs WHERE primary_thread_id = ?`).run(
        primaryThreadId,
      );
    },
  };
}

export type ReviewLedger = ReturnType<typeof createReviewLedger>;

function count(value: number | null): string {
  if (value === null) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function formatLedgerEntry(entry: LedgerEntry): string {
  const at = `${new Date(entry.startedAt).toISOString().replace("T", " ").slice(0, 19)} UTC`;
  if (entry.outcome === "skipped") {
    return `${at} seq ${entry.sourceSeq} skipped (${entry.reason})`;
  }
  const verdict =
    entry.outcome === "reviewed"
      ? `reviewed ${entry.severity ?? ""}`.trim()
      : `unavailable: ${entry.reason.slice(0, 80)}`;
  const tokens =
    entry.usageStatus === "recorded"
      ? `tokens in ${count(entry.inputTokens)} (cached ${count(entry.cachedInputTokens)}) out ${count(entry.outputTokens)} reasoning ${count(entry.reasoningTokens)}`
      : `tokens ${entry.usageStatus === "pending" ? "pending" : "unknown"}`;
  const cost =
    entry.costAmount === null ? "" : ` cost ${entry.costAmount.toFixed(4)} ${entry.costCurrency ?? ""}`.trimEnd();
  const time = entry.elapsedMs === null ? "?" : `${(entry.elapsedMs / 1000).toFixed(1)}s`;
  const evidence = entry.evidenceMode
    ? ` ${entry.evidenceMode} ${count(entry.promptChars)} chars${
        entry.carriedTurns > 0 ? `, ${entry.carriedTurns} skipped turn(s) carried` : ""
      }`
    : "";
  const model = entry.model
    ? ` ${entry.providerId}/${entry.model}@${entry.reasoningLevel}`
    : "";
  return `${at} seq ${entry.sourceSeq} ${entry.trigger} ${verdict} in ${time};${evidence}; ${tokens}${cost};${model}`;
}
