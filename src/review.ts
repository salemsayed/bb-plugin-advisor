export const ADVISOR_SEVERITIES = [
  "pass",
  "nit",
  "concern",
  "blocker",
] as const;

export type AdvisorSeverity = (typeof ADVISOR_SEVERITIES)[number];

export interface AdvisorReview {
  severity: AdvisorSeverity;
  /**
   * A stable identifier the advisor assigns to the defect itself, so the same
   * finding is recognised across rounds even when it is reworded or restated
   * at a different severity. Empty when the advisor did not supply one, in
   * which case callers fall back to matching normalized advice text.
   */
  key: string;
  summary: string;
  details: string;
}

/**
 * One parsed reviewer reply. `resolvedKeys` are keys the advisor states it
 * re-checked and now considers addressed. Closure is always an explicit
 * statement about a named key: silence about a finding never closes it,
 * because "I did not mention it" and "I verified it is fixed" are not the
 * same claim. It is deliberately not part of {@link AdvisorReview}, which is
 * also the shape of a persisted row.
 */
export interface AdvisorParsedReview extends AdvisorReview {
  resolvedKeys: string[];
}

/**
 * A persisted review. `repeatOf` is the id of the earlier review carrying
 * identical normalized advice, which means the primary agent was already told
 * this and has not resolved it — deliberately not a reason to soften the
 * severity.
 */
export interface AdvisorFinding extends AdvisorReview {
  repeatOf: number | null;
}

const SEVERITY_RANK: Record<AdvisorSeverity, number> = {
  pass: 0,
  nit: 1,
  concern: 2,
  blocker: 3,
};

export function meetsThreshold(
  severity: AdvisorSeverity,
  threshold: AdvisorSeverity,
): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}

/**
 * The stronger of two severities. A repeat is stored with this against its
 * chain's first round, because `normalizeAdvice` deliberately ignores severity:
 * the same advice restated more mildly would otherwise be persisted at the
 * milder level, softening an unresolved finding by rewording alone.
 */
export function strongerSeverity(
  left: AdvisorSeverity,
  right: AdvisorSeverity,
): AdvisorSeverity {
  return SEVERITY_RANK[left] >= SEVERITY_RANK[right] ? left : right;
}

export function normalizeAdvice(review: AdvisorReview): string {
  if (review.severity === "pass") return "";
  return `${review.summary} ${review.details}`
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Collapses cosmetic variation so a rewrapped key still matches its chain. */
export function normalizeKey(key: string): string {
  return key
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

/**
 * Null when the reply carries no recognizable verdict. Inventing a `concern`
 * from unparseable prose manufactures a finding the primary agent is then told
 * to fix and re-verify; callers must treat this as the advisor not having run.
 */
export function parseAdvisorOutput(
  output: string,
): AdvisorParsedReview | null {
  const severityMatch = output.match(
    /^\s*severity\s*:\s*(pass|nit|concern|blocker)\s*$/im,
  );
  if (!severityMatch) return null;
  const severity = severityMatch[1]!.toLowerCase() as AdvisorSeverity;
  const keyMatch = output.match(/^\s*key\s*:\s*(.+?)\s*$/im);
  const key = normalizeKey(keyMatch?.[1] ?? "");
  const summaryMatch = output.match(/^\s*summary\s*:\s*(.+?)\s*$/im);
  const detailsMatch = output.match(
    /(?:^|\r?\n)[ \t]*details[ \t]*:[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n[ \t]*(?:END_ADVISOR_RESULT|resolved[ \t]*:)[^\n]*(?:\r?\n[\s\S]*)?$|$)/i,
  );
  const fallback = output
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !/^ADVISOR_RESULT$/i.test(line) &&
        !/^severity\s*:/i.test(line) &&
        !/^key\s*:/i.test(line),
    );
  const summary = (summaryMatch?.[1] ?? fallback ?? "Advisor review").trim();
  const details = (detailsMatch?.[1] ?? output)
    .replace(/^\s*[-*]\s*none\.?\s*$/im, "")
    .trim();
  const resolvedMatch = output.match(/^[ \t]*resolved[ \t]*:[ \t]*(.+?)[ \t]*$/im);
  const resolvedKeys = [
    ...new Set(
      (resolvedMatch?.[1] ?? "")
        .split(/[,\s]+/)
        .map((candidate) => normalizeKey(candidate))
        .filter((candidate) => candidate.length > 0 && candidate !== "none"),
    ),
  ];

  return { severity, key, summary, details, resolvedKeys };
}

export function formatReview(finding: AdvisorFinding): string {
  if (finding.severity === "pass") {
    return `Advisor pass: ${finding.summary}`;
  }
  const details = finding.details.length > 0 ? `\n\n${finding.details}` : "";
  const repeat =
    finding.repeatOf === null
      ? ""
      : "\n\n(This repeats advice already given earlier in this thread, so it is still unresolved. Fix it or explain why it does not apply.)";
  return `Advisor ${finding.severity}: ${finding.summary}${details}${repeat}`;
}

export function formatTimelineRows(
  rows: readonly object[],
  maxCharacters: number,
): string {
  const selected: string[] = [];
  let used = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const line = JSON.stringify(rows[index]);
    if (selected.length === 0) {
      // The newest row is always included, but it is not exempt from the
      // budget: one large tool result would otherwise blow past it entirely.
      selected.push(
        line.length > maxCharacters ? line.slice(0, maxCharacters) : line,
      );
      used = Math.min(line.length, maxCharacters) + 1;
      continue;
    }
    if (used + line.length + 1 > maxCharacters) break;
    selected.push(line);
    used += line.length + 1;
  }
  return selected.reverse().join("\n");
}
