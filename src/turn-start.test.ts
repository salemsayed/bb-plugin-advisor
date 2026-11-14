import { describe, expect, it } from "vitest";
import { compactionUnderWay, isCompactionRequest } from "./turn-start.js";

const compactRequest = {
  input: [
    {
      type: "text",
      text: "/compact",
      mentions: [
        {
          start: 0,
          end: 8,
          resource: {
            kind: "command",
            trigger: "/",
            name: "compact",
            source: "command",
            origin: "builtin",
            label: "compact",
            argumentHint: null,
          },
        },
      ],
    },
  ],
};
const message = { input: [{ type: "text", text: "How do I /compact a thread?", mentions: [] }] };
const request = (data: unknown) => ({ type: "client/turn/requested", data });
const completed = { type: "turn/completed", data: { status: "completed" } };

describe("compaction turns", () => {
  it("recognises the built-in compact command and nothing else", () => {
    expect(isCompactionRequest(compactRequest)).toBe(true);
    expect(isCompactionRequest(message)).toBe(false);
    expect(
      isCompactionRequest({
        input: [
          {
            type: "text",
            text: "/compact",
            mentions: [{ resource: { kind: "command", origin: "project", name: "compact" } }],
          },
        ],
      }),
    ).toBe(false);
    expect(isCompactionRequest({ input: [...compactRequest.input, ...message.input] })).toBe(false);
    expect(isCompactionRequest(null)).toBe(false);
  });

  it("sees a compaction in the turn that has not completed yet", () => {
    expect(compactionUnderWay([request(compactRequest), completed, request(message)])).toBe(true);
    expect(compactionUnderWay([request(message), request(compactRequest), completed])).toBe(true);
  });

  it("does not mistake an earlier compaction for the running turn", () => {
    expect(compactionUnderWay([request(message), completed, request(compactRequest)])).toBe(false);
    expect(compactionUnderWay([completed, request(compactRequest)])).toBe(false);
    expect(compactionUnderWay([])).toBe(false);
  });
});
