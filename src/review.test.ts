import { describe, expect, it } from "vitest";
import {
  formatTimelineRows,
  meetsThreshold,
  normalizeAdvice,
  parseAdvisorOutput,
} from "./review.js";

describe("advisor review parsing", () => {
  it("parses the structured advisor envelope", () => {
    expect(
      parseAdvisorOutput(`ADVISOR_RESULT
severity: blocker
key: server-ts/migration-not-atomic
summary: The migration is not atomic
details:
- The write occurs before the transaction starts.
END_ADVISOR_RESULT`),
    ).toEqual({
      severity: "blocker",
      key: "server-ts-migration-not-atomic",
      summary: "The migration is not atomic",
      details: "- The write occurs before the transaction starts.",
      resolvedKeys: [],
    });
  });

  it("captures every line of multi-line details", () => {
    const review = parseAdvisorOutput(`ADVISOR_RESULT
severity: concern
summary: Several issues remain
details:
- Fix the first issue.
- Fix the second issue.
- Fix the third issue.
END_ADVISOR_RESULT`);

    expect(review!.details).toBe(`- Fix the first issue.
- Fix the second issue.
- Fix the third issue.`);
  });

  it("excludes the advisor result terminator from details", () => {
    const review = parseAdvisorOutput(`ADVISOR_RESULT
severity: nit
summary: One small issue
details:
- Keep the first line.
- none
- Keep the final line.
END_ADVISOR_RESULT`);

    expect(review!.details).toBe(`- Keep the first line.

- Keep the final line.`);
  });

  it("captures multi-line details without a terminator", () => {
    const review = parseAdvisorOutput(`ADVISOR_RESULT
severity: concern
summary: Several issues remain
details:
- Keep the first line.
- Keep the final line.`);

    expect(review!.details).toBe(`- Keep the first line.
- Keep the final line.`);
  });

  it("chains a reworded finding by key even when the text changes", () => {
    const first = parseAdvisorOutput(`ADVISOR_RESULT
severity: blocker
key: Server.ts / runReview timeout untested
summary: The timeout branch has no test
details:
- Add one.
END_ADVISOR_RESULT`);
    const restated = parseAdvisorOutput(`ADVISOR_RESULT
severity: nit
key: server-ts-runreview-timeout-untested
summary: Consider covering the timeout path
details:
- Minor.
END_ADVISOR_RESULT`);

    // Same defect, reworded and softened: the key still ties them together.
    expect(first!.key).toBe(restated!.key);
    expect(normalizeAdvice(first!)).not.toBe(normalizeAdvice(restated!));
  });

  it("reads the keys the advisor says it verified", () => {
    const parsed = parseAdvisorOutput(`ADVISOR_RESULT
severity: concern
key: new-defect
summary: Something else
details:
- first line
- second line
resolved: Old.Key/One, old-key-two, old-key-one
END_ADVISOR_RESULT`);
    // Normalized and deduped, and the resolved line must not bleed into details.
    expect(parsed!.resolvedKeys).toEqual(["old-key-one", "old-key-two"]);
    expect(parsed!.details).toBe("- first line\n- second line");
  });

  it("closes nothing when the advisor says none or omits the line", () => {
    // Silence is not closure: a finding it did not mention stays open.
    expect(
      parseAdvisorOutput("severity: pass\nsummary: ok\nresolved: none")!
        .resolvedKeys,
    ).toEqual([]);
    expect(
      parseAdvisorOutput("severity: nit\nsummary: ok\ndetails:\n- a")!
        .resolvedKeys,
    ).toEqual([]);
  });

  it("returns null for output carrying no verdict", () => {
    // Inventing a severity here would manufacture a finding the primary agent
    // is then told to fix; callers treat null as "the advisor did not run".
    expect(parseAdvisorOutput("The tests were never run.")).toBeNull();
    expect(parseAdvisorOutput("")).toBeNull();
  });

  it("normalizes equivalent advice and ranks thresholds", () => {
    const first = normalizeAdvice({
      severity: "concern",
      key: "",
      summary: "Stop! Missing test.",
      details: "Add `foo.test.ts`.",
    });
    const second = normalizeAdvice({
      severity: "concern",
      key: "",
      summary: " stop — missing TEST ",
      details: "add foo.test.ts",
    });
    expect(first).toBe(second);
    expect(meetsThreshold("blocker", "concern")).toBe(true);
    expect(meetsThreshold("nit", "concern")).toBe(false);
  });
});

describe("timeline formatting", () => {
  it("keeps the newest complete rows within the character budget", () => {
    const output = formatTimelineRows(
      [{ text: "old" }, { text: "middle" }, { text: "new" }],
      35,
    );
    expect(output).not.toContain("old");
    expect(output).toContain("middle");
    expect(output).toContain("new");
  });
});
