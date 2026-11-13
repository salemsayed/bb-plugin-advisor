export const ROUTINE_ANSWER_MAX_CHARACTERS = 1_500;

export const REVIEW_CADENCE_OPTIONS = [
  ["Every completed turn", "every-turn", { skipRoutine: false, every: 1 }],
  ["Substantive turns", "substantive", { skipRoutine: true, every: 1 }],
  ["Every 2nd substantive turn", "every-2nd", { skipRoutine: true, every: 2 }],
  ["Every 3rd substantive turn", "every-3rd", { skipRoutine: true, every: 3 }],
  ["Every 5th substantive turn", "every-5th", { skipRoutine: true, every: 5 }],
] as const;

export const DEFAULT_REVIEW_CADENCE_LABEL = "Substantive turns";

export interface ReviewCadence {
  skipRoutine: boolean;
  every: number;
}

export function parseReviewCadence(value: unknown): ReviewCadence {
  for (const [label, key, cadence] of REVIEW_CADENCE_OPTIONS) {
    if (value === label || value === key) return { ...cadence };
  }
  return { skipRoutine: true, every: 1 };
}

export interface TurnActivity {
  workItems: number;
  answerCharacters: number;
}

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function countWork(rows: readonly unknown[], turnId: string): number {
  let count = 0;
  for (const candidate of rows) {
    const row = asRow(candidate);
    if (!row) continue;
    if (row["kind"] === "turn") {
      if (row["turnId"] === turnId && Array.isArray(row["children"])) {
        count += countWork(row["children"], turnId);
      }
      continue;
    }
    if (row["kind"] === "work" && row["turnId"] === turnId) count += 1;
    if (Array.isArray(row["children"])) count += countWork(row["children"], turnId);
  }
  return count;
}

function latestTurnId(rows: readonly unknown[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = asRow(rows[index]);
    if (!row) continue;
    const turnId = row["turnId"];
    if (
      typeof turnId === "string" &&
      (row["kind"] === "turn" ||
        (row["kind"] === "conversation" && row["role"] === "assistant"))
    ) {
      return turnId;
    }
  }
  return null;
}

export function latestTurnActivity(
  rows: readonly unknown[],
  answer: string,
): TurnActivity | null {
  const turnId = latestTurnId(rows);
  if (turnId === null) return null;
  return {
    workItems: countWork(rows, turnId),
    answerCharacters: answer.trim().length,
  };
}

export function isRoutineTurn(activity: TurnActivity | null): boolean {
  return (
    activity !== null &&
    activity.workItems === 0 &&
    activity.answerCharacters <= ROUTINE_ANSWER_MAX_CHARACTERS
  );
}

export type CadenceDecision =
  | { review: true }
  | { review: false; reason: "routine" | "cadence" };

export function decideReview(args: {
  cadence: ReviewCadence;
  activity: TurnActivity | null;
  heldSubstantiveTurns: number;
}): CadenceDecision {
  if (
    args.cadence.skipRoutine &&
    isRoutineTurn(args.activity) &&
    args.heldSubstantiveTurns < args.cadence.every
  ) {
    return { review: false, reason: "routine" };
  }
  if (args.heldSubstantiveTurns + 1 < args.cadence.every) {
    return { review: false, reason: "cadence" };
  }
  return { review: true };
}
