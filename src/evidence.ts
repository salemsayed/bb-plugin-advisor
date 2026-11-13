export const TOOL_OUTPUT_LIMIT = { maxLines: 80, maxChars: 8_000 } as const;
export const DIFF_LIMIT = { maxLines: 300, maxChars: 8_000 } as const;
const USER_TEXT_LIMIT = { maxLines: 400, maxChars: 6_000 } as const;
const AGENT_TEXT_LIMIT = { maxLines: 400, maxChars: 8_000 } as const;
const REASONING_LIMIT = { maxLines: 40, maxChars: 1_500 } as const;
const ARGUMENTS_LIMIT = { maxLines: 40, maxChars: 1_500 } as const;
const OTHER_LIMIT = { maxLines: 40, maxChars: 2_000 } as const;
const ITEM_SEPARATOR = "\n\n";

export type EvidenceMode = "full" | "incremental";

export interface Evidence {
  mode: EvidenceMode;
  text: string;
  fromSeq: number | null;
  toSeq: number | null;
  items: number;
  omittedItems: number;
}

interface EvidenceItem {
  seqStart: number;
  seqEnd: number;
  keep: boolean;
  text: string;
}

type Row = Record<string, unknown>;

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\b(?:sk|rk|pk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED JWT]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [REDACTED]"],
  [/((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1[REDACTED]@"],
  [
    /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|client[_-]?secret|auth)(?:[_-][A-Za-z0-9]+)*["']?\s*[:=]\s*["']?)(?!\[REDACTED)[^\s"',;]{6,}/gi,
    "$1[REDACTED]",
  ],
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

export function excerpt(
  text: string,
  limit: { maxLines: number; maxChars: number },
): string {
  const lines = text.split("\n");
  if (lines.length <= limit.maxLines && text.length <= limit.maxChars) {
    return text;
  }
  const headLines = Math.ceil(limit.maxLines * 0.6);
  const tailLines = Math.max(0, limit.maxLines - headLines);
  const headBudget = Math.ceil(limit.maxChars * 0.6);
  const tailBudget = Math.max(0, limit.maxChars - headBudget);
  const head = takeChars(lines.slice(0, headLines).join("\n"), headBudget, "start");
  const tailSource =
    lines.length > headLines
      ? lines.slice(Math.max(headLines, lines.length - tailLines)).join("\n")
      : "";
  const tail = takeChars(tailSource, tailBudget, "end");
  const keptLines = countLines(head) + countLines(tail);
  const elidedLines = Math.max(0, lines.length - keptLines);
  const elidedChars = Math.max(0, text.length - head.length - tail.length);
  const marker = `[… ${elidedLines} line${elidedLines === 1 ? "" : "s"} (${elidedChars} characters) elided …]`;
  return tail.length > 0 ? `${head}\n${marker}\n${tail}` : `${head}\n${marker}`;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function takeChars(text: string, budget: number, from: "start" | "end"): string {
  const characters = Array.from(text);
  if (characters.length <= budget) return text;
  return from === "start"
    ? characters.slice(0, budget).join("")
    : characters.slice(characters.length - budget).join("");
}

function bounded(
  text: string,
  limit: { maxLines: number; maxChars: number },
): string {
  return excerpt(redactSecrets(text), limit);
}

function asRow(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function number(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function seqRange(row: Row): { seqStart: number; seqEnd: number } | null {
  const seqStart = number(row, "sourceSeqStart");
  const seqEnd = number(row, "sourceSeqEnd");
  if (seqStart === null || seqEnd === null) return null;
  return { seqStart, seqEnd };
}

function label(seqStart: number, seqEnd: number): string {
  return seqStart === seqEnd ? `[#${seqEnd}]` : `[#${seqStart}-${seqEnd}]`;
}

function statusSuffix(row: Row): string {
  const status = text(row, "status");
  return status && status !== "completed" ? ` (${status})` : "";
}

const META_KEYS = new Set([
  "id",
  "threadId",
  "turnId",
  "sourceSeqStart",
  "sourceSeqEnd",
  "startedAt",
  "createdAt",
  "completedAt",
  "kind",
  "workKind",
  "systemKind",
  "presentation",
  "callId",
  "activityIntents",
  "approvalStatus",
  "contentDeferred",
  "outputPreview",
  "status",
  "attachments",
  "turnRequest",
  "children",
  "reasoningId",
  "messageSeq",
]);

function remainingFields(row: Row): string {
  const rest: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (META_KEYS.has(key) || value === null || value === "") continue;
    rest[key] = value;
  }
  return Object.keys(rest).length === 0 ? "" : JSON.stringify(rest);
}

function renderSourceRow(row: Row): EvidenceItem | null {
  const range = seqRange(row);
  if (!range) return null;
  const at = label(range.seqStart, range.seqEnd);
  const kind = text(row, "kind");
  const item = (body: string, keep = false): EvidenceItem => ({
    ...range,
    keep,
    text: `${at} ${body}`,
  });

  if (kind === "conversation") {
    const role = text(row, "role");
    const body = text(row, "text") ?? "";
    if (role === "user") return item(`USER: ${bounded(body, USER_TEXT_LIMIT)}`, true);
    if (role === "assistant") {
      if (body.trim().length === 0) return null;
      return item(`AGENT: ${bounded(body, AGENT_TEXT_LIMIT)}`);
    }
    return item(`${role ?? "message"}: ${bounded(body, OTHER_LIMIT)}`);
  }

  if (kind === "system") {
    const operation = text(row, "operationKind") ?? text(row, "systemKind") ?? "system";
    const detail = text(row, "detail") ?? "";
    if (operation === "reasoning") {
      return detail.trim().length === 0
        ? null
        : item(`reasoning: ${bounded(detail, REASONING_LIMIT)}`);
    }
    const title = text(row, "title") ?? "";
    return item(
      `system ${operation}${statusSuffix(row)}: ${bounded(
        [title, detail].filter((part) => part.length > 0).join(" — "),
        REASONING_LIMIT,
      )}`,
    );
  }

  if (kind !== "work") {
    const fields = remainingFields(row);
    return fields ? item(`${kind ?? "row"}: ${bounded(fields, OTHER_LIMIT)}`) : null;
  }

  const workKind = text(row, "workKind") ?? "work";
  if (workKind === "command") {
    const exitCode = number(row, "exitCode");
    const head = `$ ${bounded(text(row, "command") ?? "", ARGUMENTS_LIMIT)}${
      exitCode === null ? "" : ` (exit ${exitCode})`
    }${statusSuffix(row)}`;
    const output = text(row, "output") ?? "";
    return item(
      output.trim().length === 0
        ? head
        : `${head}\n${bounded(output, TOOL_OUTPUT_LIMIT)}`,
    );
  }
  if (workKind === "file-change") {
    const change = asRow(row["change"]) ?? {};
    const path = text(change, "path") ?? "(unknown file)";
    const changeKind = text(change, "kind") ?? "edit";
    const movePath = text(change, "movePath");
    const diff = text(change, "diff") ?? "";
    const head = `edit ${changeKind} ${path}${movePath ? ` -> ${movePath}` : ""}${statusSuffix(row)}`;
    return item(
      diff.trim().length === 0 ? head : `${head}\n${bounded(diff, DIFF_LIMIT)}`,
    );
  }
  if (workKind === "file-read") {
    return item(`read ${text(row, "path") ?? text(row, "cmd") ?? "(unknown file)"}${statusSuffix(row)}`);
  }
  if (workKind === "tool") {
    const name = text(row, "toolName") ?? "tool";
    const args = row["toolArgs"];
    const output = text(row, "output") ?? "";
    const head = `tool ${name}${statusSuffix(row)}${
      args === null || args === undefined
        ? ""
        : ` ${bounded(JSON.stringify(args), ARGUMENTS_LIMIT)}`
    }`;
    return item(
      output.trim().length === 0
        ? head
        : `${head}\n${bounded(output, TOOL_OUTPUT_LIMIT)}`,
    );
  }
  const fields = remainingFields(row);
  return item(
    `${workKind}${statusSuffix(row)}${fields ? `: ${bounded(fields, OTHER_LIMIT)}` : ""}`,
  );
}

function flattenRows(rows: readonly unknown[], into: EvidenceItem[]): void {
  for (const candidate of rows) {
    const row = asRow(candidate);
    if (!row) continue;
    if (text(row, "kind") === "turn") {
      const children = row["children"];
      if (Array.isArray(children)) flattenRows(children, into);
      const status = text(row, "status");
      const range = seqRange(row);
      if (range && status && status !== "completed" && status !== "pending") {
        into.push({
          seqStart: range.seqEnd,
          seqEnd: range.seqEnd,
          keep: true,
          text: `${label(range.seqEnd, range.seqEnd)} turn ended: ${status}`,
        });
      }
      continue;
    }
    const item = renderSourceRow(row);
    if (item) into.push(item);
  }
}

function omissionMarker(items: readonly EvidenceItem[]): string {
  const first = items[0]!;
  const last = items[items.length - 1]!;
  return `[… ${items.length} timeline entr${items.length === 1 ? "y" : "ies"} (${label(
    first.seqStart,
    last.seqEnd,
  )}) omitted to fit the evidence budget; inspect the thread if they matter …]`;
}

function cap(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  const kept = takeChars(text, Math.max(0, maxCharacters - 100), "end");
  return `[… ${text.length - kept.length} earlier characters elided to fit the evidence budget …]\n${kept}`;
}

export function renderEvidence(
  rows: readonly unknown[],
  options: { afterSeq: number | null; maxCharacters: number },
): Evidence {
  const all: EvidenceItem[] = [];
  flattenRows(rows, all);
  all.sort((left, right) => left.seqEnd - right.seqEnd || left.seqStart - right.seqStart);
  const fresh =
    options.afterSeq === null
      ? all
      : all.filter((item) => item.seqEnd > options.afterSeq!);
  const lastAgent = [...fresh]
    .reverse()
    .find((item) => /^\[#[\d-]+\] AGENT: /.test(item.text));
  if (lastAgent) lastAgent.keep = true;

  const separator = ITEM_SEPARATOR.length;
  const kept = fresh.filter((item) => item.keep);
  const markerAllowance = (kept.length + 1) * 180;
  let used = kept.reduce((total, item) => total + item.text.length + separator, 0);
  const included = new Set<EvidenceItem>(kept);
  for (let index = fresh.length - 1; index >= 0; index -= 1) {
    const item = fresh[index]!;
    if (item.keep) continue;
    const cost = item.text.length + separator;
    if (used + cost + markerAllowance > options.maxCharacters) break;
    included.add(item);
    used += cost;
  }

  const parts: string[] = [];
  let omitted: EvidenceItem[] = [];
  let omittedItems = 0;
  for (const item of fresh) {
    if (included.has(item)) {
      if (omitted.length > 0) {
        parts.push(omissionMarker(omitted));
        omittedItems += omitted.length;
        omitted = [];
      }
      parts.push(item.text);
    } else {
      omitted.push(item);
    }
  }
  if (omitted.length > 0) {
    parts.push(omissionMarker(omitted));
    omittedItems += omitted.length;
  }

  return {
    mode: options.afterSeq === null ? "full" : "incremental",
    text: cap(parts.join(ITEM_SEPARATOR), options.maxCharacters),
    fromSeq: fresh[0]?.seqStart ?? null,
    toSeq: fresh[fresh.length - 1]?.seqEnd ?? null,
    items: fresh.length - omittedItems,
    omittedItems,
  };
}
