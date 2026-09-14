// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

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

// Looked up by id rather than by position: the switch and the pending-advice
// banner are separate registrations, and an index would silently follow a
// reorder into the wrong one.
const switchCustomization = app.composerCustomizations.find(
  (customization) => customization.id === "advisor-switch",
)!;
const toggleSlot = switchCustomization.actions![0]!;
const threadComposer = {
  scope: { kind: "thread", threadId: "t1" } as const,
};
describe("advisor thread switch", () => {
  it("reports the effective state of a thread that follows the default", async () => {
    const slot = renderSlot(toggleSlot, {}, {
      composer: threadComposer,
      rpc: {
        threadToggle: () => ({
          enabled: false,
          override: null,
          globalEnabled: false,
        }),
      },
    });

    const control = await q(slot).findByRole("switch");
    // The switch shows what actually happens in this thread, not whether the
    // user picked it — a thread following a disabled default reads as off.
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(control.getAttribute("aria-label")).toBe("Advisor off");
  });

  it("writes an explicit override for this thread when clicked", async () => {
    let stored: { enabled: boolean | null } = { enabled: null };
    const slot = renderSlot(toggleSlot, {}, {
      composer: threadComposer,
      rpc: {
        threadToggle: () => ({
          enabled: stored.enabled ?? true,
          override: stored.enabled,
          globalEnabled: true,
        }),
        setThreadToggle: (input) => {
          stored = z.object({ enabled: z.boolean().nullable() }).parse(input);
          return {
            enabled: stored.enabled ?? true,
            override: stored.enabled,
            globalEnabled: true,
          };
        },
      },
    });

    fireEvent.click(await q(slot).findByRole("switch"));

    await waitFor(() =>
      expect(q(slot).getByRole("switch").getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "setThreadToggle"),
    ).toEqual([
      { method: "setThreadToggle", input: { threadId: "t1", enabled: false } },
    ]);
  });

  it("snaps back instead of claiming a switch the server rejected", async () => {
    const slot = renderSlot(toggleSlot, {}, {
      composer: threadComposer,
      rpc: {
        threadToggle: () => ({
          enabled: true,
          override: null,
          globalEnabled: true,
        }),
        setThreadToggle: () => {
          throw new Error("plugin unavailable");
        },
      },
    });

    fireEvent.click(await q(slot).findByRole("switch"));

    // The advisor still runs, so the surface must not show an "off" switch.
    await waitFor(() => expect(q(slot).queryByRole("switch")).toBeNull());
    expect(
      (await q(slot).findByRole("button")).getAttribute("title"),
    ).toContain("plugin unavailable");
  });

  it("names what it does on hover without waiting for the native tooltip", async () => {
    const slot = renderSlot(toggleSlot, {}, {
      composer: threadComposer,
      rpc: {
        threadToggle: () => ({
          enabled: true,
          override: null,
          globalEnabled: true,
        }),
      },
    });

    expect((await q(slot).findByRole("tooltip")).textContent).toBe("Advisor on");
    // A native `title` alongside it would surface a second, slower duplicate.
    expect(q(slot).getByRole("switch").getAttribute("title")).toBeNull();
  });

  it("renders nothing in a composer scope it has no answer for", async () => {
    const slot = renderSlot(toggleSlot, {}, {
      composer: {
        scope: {
          kind: "side-chat",
          projectId: "p1",
          parentThreadId: "t1",
          tabId: "tab1",
          childThreadId: null,
        } as const,
      },
      rpc: {
        threadToggle: () => ({
          enabled: true,
          override: null,
          globalEnabled: true,
        }),
      },
    });

    await waitFor(() => expect(slot.container.firstChild).toBeNull());
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  it("does not offer the switch in a new-thread composer", async () => {
    expect(switchCustomization.scopes).toEqual(["thread"]);
    const slot = renderSlot(toggleSlot, {}, {
      composer: { scope: { kind: "new-thread", projectId: "p1" } },
    });
    expect(slot.container.firstChild).toBeNull();
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  it("ignores another click until the server confirms a toggle", async () => {
    let enabled = true;
    let finish: (() => void) | undefined;
    const slot = renderSlot(toggleSlot, {}, {
      composer: threadComposer,
      rpc: {
        threadToggle: () => ({ enabled, override: enabled, globalEnabled: true }),
        setThreadToggle: async (input) => {
          await new Promise<void>((resolve) => { finish = resolve; });
          enabled = z.object({ enabled: z.boolean() }).parse(input).enabled;
          return { enabled, override: enabled, globalEnabled: true };
        },
      },
    });
    const control = await q(slot).findByRole("switch") as HTMLButtonElement;
    fireEvent.click(control);
    expect(control.disabled).toBe(true);
    fireEvent.click(control);
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "setThreadToggle"))
      .toHaveLength(1);
    await act(async () => { finish!(); });
    await waitFor(() => expect(control.disabled).toBe(false));
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("reloads a following thread when the global default changes", async () => {
    let enabled = true;
    const slot = renderSlot(toggleSlot, {}, {
      composer: threadComposer,
      rpc: { threadToggle: () => ({ enabled, override: null, globalEnabled: enabled }) },
    });
    expect((await q(slot).findByRole("switch")).getAttribute("aria-checked")).toBe("true");
    enabled = false;
    await slot.behavior.emitRealtime("advisor-settings-changed", {});
    await waitFor(() => expect(q(slot).getByRole("switch").getAttribute("aria-checked")).toBe("false"));
  });
});

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
  it("replaces a hung request with a retry and ignores its late response", async () => {
    vi.useFakeTimers();
    let finishFirst: (value: unknown) => void = () => {};
    let requests = 0;
    const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: {
      modelConfiguration: () => ++requests === 1
        ? new Promise((resolve) => { finishFirst = resolve; })
        : { hosts: [] },
    } });
    try {
      expect(q(slot).getByText("Loading machine models…")).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(q(slot).queryByText("Loading machine models…")).toBeNull();
      expect(q(slot).getByRole("alert").textContent).toContain("timed out");
      await act(async () => { fireEvent.click(q(slot).getByRole("button", { name: "Refresh models" })); });
      expect(q(slot).getByText("No enrolled machines found.")).toBeTruthy();
      await act(async () => { finishFirst({ hosts: [{ hostId: "late", hostName: "Stale machine", connected: false,
        selection: null, options: [], error: null }] }); });
      expect(q(slot).queryByText("Stale machine")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { slot.lifecycle.unmount(); vi.useRealTimers(); }
  });

  it("shows partial discovery errors without disguising a saved model as follow-primary", async () => {
    const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: {
      modelConfiguration: () => ({ hosts: [{
        hostId: "host-laptop", hostName: "Laptop", connected: true,
        selection: { providerId: "stuck", model: "saved-model", reasoningLevel: "default" },
        options: [{ providerId: "codex", providerName: "Codex", model: "gpt-advisor",
          modelName: "GPT Advisor", isDefault: false, supportedReasoningLevels: ["medium"],
          defaultReasoningLevel: "medium" }],
        error: "stuck: Model discovery timed out after 5 seconds.",
      }] }),
    } });
    const select = await q(slot).findByLabelText("Advisor model for Laptop") as HTMLSelectElement;
    expect(select.value).toBe("unavailable");
    expect(select.textContent).toContain("Codex · GPT Advisor");
    expect(select.textContent).toContain("Saved: stuck · saved-model (not loaded)");
    expect(q(slot).getByText("stuck: Model discovery timed out after 5 seconds.")).toBeTruthy();
    expect(slot.rpcCalls.some((call) => call.method === "setHostModel")).toBe(false);
    slot.lifecycle.unmount();
  });

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
    await waitFor(() => expect(select.value).toBe("0"));
    expect(slot.rpcCalls.filter((call) => call.method === "modelConfiguration")).toHaveLength(1);
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
