// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

/**
 * `renderSlot` queries are document.body-scoped and its roots survive RTL's
 * `cleanup`, so an unscoped query reads whatever earlier tests left mounted.
 * Every assertion below is scoped to the slot that produced it.
 */
function q(slot: { container: HTMLElement }) {
  return within(slot.container);
}

const badgeSlot = app.threadHeaderActions[0]!;
const panelSlot = app.threadPanelActions[0]!;
const badgeProps = {
  threadId: "t1",
  projectId: "p1",
  isCompactViewport: false,
};

function emptyBadge() {
  return {
    open: null,
    latest: null,
    unavailableCount: 0,
    latestIsUnavailable: false,
    latestUnavailableReason: null,
    reviewing: false,
    lifecycle: "unreviewed" as const,
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    chainId: 1,
    severity: "concern" as const,
    summary: "Verification is incomplete",
    details: "- Run the test.",
    sourceSeq: 10,
    createdAt: Date.now(),
    providerId: "codex",
    model: "gpt-5.6",
    reasoningLevel: "high",
    repeatCount: 1,
    firstSourceSeq: 10,
    firstCreatedAt: Date.now(),
    advisorThreadId: null,
    resolvedAt: null,
    resolvedReason: "",
    sentAt: null,
    decision: "",
    closedAt: null,
    closedSeq: null,
    continuedAt: null,
    ...overrides,
  };
}

function panel(reviews: unknown[], extra: Record<string, unknown> = {}) {
  return {
    reviews,
    incidents: [],
    advisorThreadId: null,
    reviewing: false,
    lifecycle: "unreviewed" as const,
    ...extra,
  };
}

describe("advisor header badge", () => {
  it("keeps advertising an open blocker after a later turn passes", async () => {
    // The whole point: a clean turn does not close an earlier finding, and the
    // finding is still being fed back to the agent.
    const slot = renderSlot(badgeSlot, badgeProps, {
      rpc: {
        threadBadge: () => ({
          ...emptyBadge(),
          open: {
            chainId: 7,
            severity: "blocker" as const,
            summary: "Migration is not atomic",
            repeatCount: 3,
          },
          latest: {
            severity: "pass" as const,
            summary: "Looks correct",
            repeatCount: 1,
          },
        }),
      },
    });

    expect(await q(slot).findByText("Must fix")).toBeTruthy();
    expect(q(slot).queryByText("No issues")).toBeNull();
    expect(await q(slot).findByText("×3")).toBeTruthy();
  });

  it("shows a failed review ahead of an open finding", async () => {
    const slot = renderSlot(badgeSlot, badgeProps, {
      rpc: {
        threadBadge: () => ({
          ...emptyBadge(),
          open: {
            chainId: 7,
            severity: "blocker" as const,
            summary: "Migration is not atomic",
            repeatCount: 1,
          },
          unavailableCount: 1,
          latestIsUnavailable: true,
          latestUnavailableReason: "the reviewer timed out",
        }),
      },
    });

    expect(await q(slot).findByText("Didn't run")).toBeTruthy();
    expect(q(slot).queryByText("Must fix")).toBeNull();
  });
});

describe("advisor panel", () => {
  it("counts open findings without counting clean turns", async () => {
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () =>
          panel([
            review({ id: 1, chainId: 1, severity: "pass", summary: "Fine" }),
            review({ id: 2, chainId: 2, severity: "pass", summary: "Also fine" }),
            review({ id: 3, chainId: 3, severity: "blocker", summary: "Broken" }),
            review({
              id: 4,
              chainId: 4,
              severity: "concern",
              summary: "Settled already",
              resolvedAt: Date.now(),
              resolvedReason: "intentional",
            }),
          ]),
      },
    });

    // Two passes are history; the settled chain is an outcome, not open work.
    expect(await q(slot).findByText("1 open")).toBeTruthy();
    expect(await q(slot).findByText("1 decided")).toBeTruthy();
    expect(await q(slot).findByText("Review log (2)")).toBeTruthy();
  });

  it("says what happened to each finding", async () => {
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () =>
          panel([
            review({ id: 1, chainId: 1, severity: "blocker", summary: "Queued one" }),
            review({
              id: 2,
              chainId: 2,
              severity: "concern",
              summary: "Sent one",
              sentAt: Date.now(),
            }),
            review({
              id: 3,
              chainId: 3,
              severity: "blocker",
              summary: "Ignored one",
              repeatCount: 4,
              sentAt: Date.now(),
            }),
          ]),
      },
    });

    // Never told the agent yet, told once, and told repeatedly without effect
    // are three different facts and must read differently.
    expect(
      await q(slot).findByText(
        "Queued — goes to the agent with your next message",
      ),
    ).toBeTruthy();
    expect(await q(slot).findByText(/^Sent to the agent/)).toBeTruthy();
    expect(
      await q(slot).findByText("Re-raised 4× — not addressed"),
    ).toBeTruthy();
  });

  it("attributes a settled finding to whoever settled it", async () => {
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () =>
          panel([
            review({
              id: 1,
              chainId: 1,
              severity: "concern",
              summary: "You fixed this",
              resolvedAt: Date.now(),
              decision: "fixed",
            }),
            review({
              id: 2,
              chainId: 2,
              severity: "blocker",
              summary: "Advisor closed this",
              closedAt: Date.now(),
              closedSeq: 51,
            }),
          ]),
      },
    });

    expect(await q(slot).findByText(/^You marked it fixed/)).toBeTruthy();
    expect(
      await q(slot).findByText("Advisor re-checked and closed it at turn 51"),
    ).toBeTruthy();
    // Both are outcomes, not open work.
    expect(await q(slot).findByText("0 open")).toBeTruthy();
    expect(await q(slot).findByText("2 decided")).toBeTruthy();
  });

  it("starts a corrective turn instead of letting the user self-certify a fix", async () => {
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () =>
          panel([review({ id: 9, chainId: 5, severity: "blocker" })]),
        continueFinding: () => ({
          started: true,
          reason: "started" as const,
        }),
      },
    });

    fireEvent.click(await q(slot).findByText("Verification is incomplete"));
    fireEvent.click(await q(slot).findByText("Fix in new turn"));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "continueFinding",
        input: {
          threadId: "t1",
          reviewId: 9,
        },
      }),
    );
  });

  it("asks for a review and refuses to double-fire while one is running", async () => {
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () => panel([]),
        requestReview: () => ({ started: true, waiting: false }),
      },
    });

    fireEvent.click(await q(slot).findByText("Review now"));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "requestReview",
        input: { threadId: "t1" },
      }),
    );
  });

  it("disables the trigger while the server reports a review in flight", async () => {
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () =>
          panel([], { reviewing: true, lifecycle: "pending" }),
      },
    });

    const button = (await q(slot).findByText("Reviewing…")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("lets the user overrule a finding by chain", async () => {
    // Repeats can only escalate on their own, so this is the only way a wrong
    // finding stops re-entering the agent's instructions.
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () =>
          panel([review({ id: 9, chainId: 5, severity: "blocker" })]),
        resolveFinding: () => ({ ok: true as const, resolved: true }),
      },
    });

    fireEvent.click(await q(slot).findByText("Verification is incomplete"));
    fireEvent.click(await q(slot).findByText("Not an issue"));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "resolveFinding",
        input: {
          threadId: "t1",
          chainId: 5,
          resolved: true,
          reason: "",
          decision: "not-an-issue",
        },
      }),
    );
  });
});

describe("advisor model settings", () => {
  it("renders machine-local models and saves the selected provider/model pair", async () => {
    const configuration = {
      hosts: [
        {
          hostId: "host-laptop",
          hostName: "Laptop",
          connected: true,
          selection: null,
          options: [
            {
              providerId: "codex",
              providerName: "Codex",
              model: "gpt-advisor",
              modelName: "GPT Advisor",
              isDefault: false,
              supportedReasoningLevels: ["low", "medium", "high"],
              defaultReasoningLevel: "medium",
            },
          ],
          error: null,
        },
      ],
    };
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          modelConfiguration: () => configuration,
          setHostModel: () => ({ ok: true as const }),
        },
      },
    );

    const select = (await slot.findByLabelText(
      "Advisor model for Laptop",
    )) as HTMLSelectElement;
    expect(select.value).toBe("follow");
    expect(select.textContent).toContain("Codex · GPT Advisor");

    fireEvent.change(select, { target: { value: "0" } });
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setHostModel",
        input: {
          hostId: "host-laptop",
          selection: {
            providerId: "codex",
            model: "gpt-advisor",
            reasoningLevel: "default",
          },
        },
      }),
    );
  });

  it("saves a supported reasoning level with the machine model", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          modelConfiguration: () => ({
            hosts: [
              {
                hostId: "host-laptop",
                hostName: "Laptop",
                connected: true,
                selection: {
                  providerId: "codex",
                  model: "gpt-advisor",
                  reasoningLevel: "default" as const,
                },
                options: [
                  {
                    providerId: "codex",
                    providerName: "Codex",
                    model: "gpt-advisor",
                    modelName: "GPT Advisor",
                    isDefault: false,
                    supportedReasoningLevels: ["low", "medium", "high"] as const,
                    defaultReasoningLevel: "medium" as const,
                  },
                ],
                error: null,
              },
            ],
          }),
          setHostModel: () => ({ ok: true as const }),
        },
      },
    );

    const reasoning = (await slot.findByLabelText(
      "Advisor reasoning for Laptop",
    )) as HTMLSelectElement;
    expect(reasoning.value).toBe("default");
    expect(reasoning.textContent).toContain("Model default (medium)");

    fireEvent.change(reasoning, { target: { value: "high" } });
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setHostModel",
        input: {
          hostId: "host-laptop",
          selection: {
            providerId: "codex",
            model: "gpt-advisor",
            reasoningLevel: "high",
          },
        },
      }),
    );
  });
});
