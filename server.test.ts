import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@bb/plugin-sdk";
import plugin, { parseRuntimeSettings } from "./server.js";

const primaryContext = {
  thread: {
    id: "thread-primary",
    title: "Implement feature",
    parentThreadId: null,
    sourceThreadId: null,
  },
  project: {
    id: "project-test",
    kind: "standard",
    name: "Test",
    gitRemoteUrl: null,
  },
  environment: {
    id: "environment-test",
    name: null,
    path: "/workspace",
    workspaceProvisionType: "unmanaged",
    branchName: null,
  },
  host: { id: "host-test", name: "Test host" },
  provider: { id: "codex", model: "gpt-5.6" },
  origin: { kind: null, pluginId: null },
} satisfies PluginAgentConfigurationContext;

function timeline(maxSeq: number) {
  return {
    rows: [{ kind: "conversation", role: "assistant", text: "Implemented it." }],
    maxSeq,
  };
}

async function loadAdvisor(
  output: string,
  storedSettings: Record<string, string | boolean> = {},
) {
  let timelineSeq = 42;
  let currentOutput = output;
  const spawn = vi.fn(async (_args: { prompt?: string }) =>
    makeThreadResponse({
      id: "thread-advisor",
      projectId: "project-test",
      environmentId: "environment-test",
      providerId: "codex",
      originPluginId: "advisor",
      visibility: "hidden",
      status: "active",
    }),
  );
  const host = createFakePluginHost({
    pluginId: "advisor",
    settings: { autoReview: false, ...storedSettings },
    sdk: {
      threads: {
        timeline: async () => timeline(timelineSeq),
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            projectId: "project-test",
            environmentId: "environment-test",
            providerId: "codex",
            title: threadId === "thread-primary" ? "Implement feature" : "Advisor",
            status: "idle",
          }),
        spawn,
        wait: async () => ({ matched: true }),
        output: async () => ({ output: currentOutput }),
        send: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
        defaultExecutionOptions: async () => ({
          model: "gpt-5.6",
          serviceTier: "none",
          reasoningLevel: "high",
          permissionMode: "readonly",
          source: "client/turn/start",
        }),
      },
    },
  });
  await plugin(host.bb);
  await host.harness.resolveAgentConfiguration(primaryContext);
  return {
    ...host,
    spawn,
    setTimelineSeq(next: number) {
      timelineSeq = next;
    },
    setAdvisorOutput(next: string) {
      currentOutput = next;
    },
  };
}

async function loadAutoAdvisor(output: string) {
  const host = await loadAdvisor(output);
  await host.harness.setSettings({ autoReview: true });
  return host;
}

describe("advisor agent configuration", () => {
  it("requires the advisor gate for primary threads but not plugin-owned reviewers", async () => {
    const { harness } = await loadAdvisor(`ADVISOR_RESULT
severity: pass
summary: Looks correct
details:
none
END_ADVISOR_RESULT`);
    const primary = await harness.resolveAgentConfiguration(primaryContext);
    expect(primary.tools.map((tool) => tool.name)).toEqual(["advisor_review"]);
    expect(primary.instructions).toContain("MUST call advisor_review");

    const reviewer = await harness.resolveAgentConfiguration({
      ...primaryContext,
      thread: { ...primaryContext.thread, id: "thread-advisor" },
      origin: { kind: null, pluginId: "advisor" },
    });
    expect(reviewer.tools).toEqual([]);
    expect(reviewer.instructions).toBeNull();
  });
});

describe("advisor storage migrations", () => {
  it("preserves legacy selections and sessions while adding reasoning state", async () => {
    const host = createFakePluginHost({ pluginId: "advisor" });
    const db = host.bb.storage.database();
    db.exec(`
      CREATE TABLE advisor_sessions (
        primary_thread_id TEXT PRIMARY KEY,
        advisor_thread_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE advisor_host_models (
        host_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO advisor_sessions VALUES (
        'primary', 'reviewer', 'codex', 'gpt-old', 1, 1
      );
      INSERT INTO advisor_host_models VALUES (
        'host-old', 'codex', 'gpt-old', 1
      );
      CREATE TABLE advisor_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        primary_thread_id TEXT NOT NULL,
        source_seq INTEGER NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT NOT NULL,
        normalized TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      INSERT INTO advisor_reviews (
        primary_thread_id, source_seq, severity, summary, details,
        normalized, created_at, delivered_at
      ) VALUES (
        'primary', 7, 'concern', 'Legacy finding', 'old details',
        'legacy finding old details', 1, 1
      );
    `);

    await plugin(host.bb);

    expect(
      db
        .prepare(
          `SELECT provider_id, model, reasoning_level
           FROM advisor_host_models WHERE host_id = 'host-old'`,
        )
        .get(),
    ).toEqual({
      provider_id: "codex",
      model: "gpt-old",
      reasoning_level: "default",
    });
    // A legacy session carries no environment, so it can never match a live
    // one and is rebuilt against the primary thread's current environment.
    expect(
      db
        .prepare(
          `SELECT provider_id, model, reasoning_level, environment_id
           FROM advisor_sessions WHERE primary_thread_id = 'primary'`,
        )
        .get(),
    ).toEqual({
      provider_id: "codex",
      model: "gpt-old",
      reasoning_level: "legacy",
      environment_id: "",
    });
    // A pre-existing review survives with defaults the surfaces can render:
    // no repeat lineage, and empty provenance rather than a bogus model name.
    expect(
      db
        .prepare(
          `SELECT severity, repeat_of, provider_id, model, reasoning_level,
                  advisor_thread_id, resolved_at, resolved_reason
           FROM advisor_reviews WHERE primary_thread_id = 'primary'`,
        )
        .get(),
    ).toEqual({
      severity: "concern",
      repeat_of: null,
      provider_id: "",
      model: "",
      reasoning_level: "",
      advisor_thread_id: "",
      resolved_at: null,
      resolved_reason: "",
    });
  });
});

describe("advisor settings compatibility", () => {
  it("exposes auto-continue as an opt-in native settings control", async () => {
    const { harness } = await loadAdvisor("severity: pass\nsummary: fine");
    expect(harness.registrations.settingsDescriptors.autoContinue).toMatchObject(
      {
        type: "boolean",
        label: "Auto-continue on late findings",
        default: false,
      },
    );
  });

  it("maps a legacy stored timeout value to the new labeled setting", async () => {
    const common = {
      enabled: true,
      autoReview: false,
      autoContinue: false,
      advisorReasoning: "inherit",
      severityThreshold: "nit",
      watchdogFile: "WATCHDOG.md",
    };
    expect(
      parseRuntimeSettings({
        ...common,
        timeoutSeconds: "30",
        transcriptSize: "20000",
      }),
    ).toMatchObject({ timeoutSeconds: 30, transcriptSize: 20_000 });
    expect(
      parseRuntimeSettings({
        ...common,
        timeoutSeconds: "30 seconds",
        transcriptSize: "20,000 characters",
      }),
    ).toMatchObject({ timeoutSeconds: 30, transcriptSize: 20_000 });
    expect(
      parseRuntimeSettings({
        ...common,
        timeoutSeconds: "obsolete",
        transcriptSize: "obsolete",
      }),
    ).toMatchObject({ timeoutSeconds: 120, transcriptSize: 60_000 });
  });

  // Parsing legacy values is not enough on its own: the host reads stored
  // settings in apps/server/src/services/plugins/plugin-settings.ts and drops
  // any select value missing from `options`, substituting the default before
  // the plugin ever sees it. These strings are already on disk from earlier
  // versions and are historical facts, so they must stay declared.
  const LEGACY_PERSISTED_SELECT_VALUES = {
    timeoutSeconds: ["30", "60", "120", "300", "600"],
    transcriptSize: ["20000", "60000", "120000"],
  } as const;

  it("still declares every legacy value it claims to accept", async () => {
    const { harness } = await loadAdvisor("severity: pass\nsummary: fine");
    for (const [key, legacyValues] of Object.entries(
      LEGACY_PERSISTED_SELECT_VALUES,
    )) {
      const descriptor = harness.registrations.settingsDescriptors[key];
      expect(descriptor?.type).toBe("select");
      const options = descriptor?.type === "select" ? descriptor.options : [];
      for (const legacy of legacyValues) {
        expect(options).toContain(legacy);
      }
    }
  });

  it("honours a legacy stored timeout through the host's select filter", async () => {
    // End-to-end past the filter above — the unit test on parseRuntimeSettings
    // cannot see a value the host already replaced with the default.
    const { harness } = await loadAdvisor(
      `ADVISOR_RESULT
severity: pass
summary: fine
details:
none
END_ADVISOR_RESULT`,
      { timeoutSeconds: "30" },
    );
    await harness.callAgentTool(
      "advisor_review",
      { focus: "" },
      { threadId: "thread-primary", projectId: "project-test" },
    );
    expect(harness.sdk.callsTo("threads.wait")).toEqual([
      [expect.objectContaining({ timeoutMs: 30_000 })],
    ]);
  });
});

describe("advisor review gate", () => {
  it("gives the reviewer a bounded deadline and requires a final-only response", async () => {
    const { harness, spawn } = await loadAdvisor(
      `ADVISOR_RESULT
severity: pass
key: none
summary: Looks correct
details:
- none
resolved: none
END_ADVISOR_RESULT`,
      { timeoutSeconds: "2 minutes" },
    );

    await harness.callAgentTool(
      "advisor_review",
      { focus: "Check the focused change." },
      { threadId: "thread-primary", projectId: "project-test" },
    );

    const prompt = spawn.mock.lastCall?.[0].prompt;
    expect(prompt).toBeDefined();
    expect(prompt).toContain("stops this review after 120 seconds");
    expect(prompt).toContain("reserve the final 30 seconds");
    expect(prompt).toContain("Do not send progress updates");
    expect(prompt).toContain("at most 6 read-only inspection or command actions");
    expect(prompt).toContain("Do not rerun broad test suites or builds");
    expect(prompt).toContain("has not written its final answer yet");
    expect(prompt).toContain("must never be reported as a missing-answer finding");
  });

  it("scales a 30-second review budget and steers finalization before cutoff", async () => {
    vi.useFakeTimers();
    try {
      const { harness, spawn } = await loadAdvisor(
        `ADVISOR_RESULT
severity: pass
key: none
summary: Looks correct
details:
- none
resolved: none
END_ADVISOR_RESULT`,
        { timeoutSeconds: "30 seconds" },
      );
      const send = vi.fn(async () => ({ ok: true as const }));
      harness.sdk.stub("threads.send", send);
      harness.sdk.stub(
        "threads.wait",
        async () =>
          await new Promise<{ matched: true }>((resolve) => {
            setTimeout(() => resolve({ matched: true }), 22_500);
          }),
      );

      const result = harness.callAgentTool(
        "advisor_review",
        { focus: "Check the focused change." },
        { threadId: "thread-primary", projectId: "project-test" },
      );
      await vi.advanceTimersByTimeAsync(22_000);

      const prompt = spawn.mock.lastCall?.[0].prompt;
      expect(prompt).toContain("stops this review after 30 seconds");
      expect(prompt).toContain("reserve the final 8 seconds");
      expect(prompt).toContain("at most 1 read-only inspection or command actions");
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-advisor",
          mode: "steer-if-active",
        }),
      );

      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toContain("Advisor pass");
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawns a hidden review-only reviewer in the same environment", async () => {
    const { harness, spawn } = await loadAdvisor(`ADVISOR_RESULT
severity: concern
summary: Verification is incomplete
details:
- Run the focused integration test.
END_ADVISOR_RESULT`);
    harness.sdk.stub("providers.models", async () => ({
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          available: true,
          // Both acceptable modes on offer: the reviewer must take the
          // narrower one.
          capabilities: {
            supportedPermissionModes: ["readonly", "accept-edits", "full"],
          },
        },
      ],
      models: [],
      modelLoadError: null,
    }));

    await expect(
      harness.callAgentTool(
        "advisor_review",
        { focus: "Implemented the route and ran typecheck." },
        { threadId: "thread-primary", projectId: "project-test" },
      ),
    ).resolves.toContain("Advisor concern: Verification is incomplete");

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-test",
        providerId: "codex",
        model: "gpt-5.6",
        permissionMode: "readonly",
        environment: { type: "reuse", environmentId: "environment-test" },
        visibility: "hidden",
      }),
    );
    expect(harness.sdk.callsTo("threads.wait")).toEqual([
      [expect.objectContaining({ threadId: "thread-advisor", status: "idle" })],
    ]);
  });

  it("deduplicates a review of the same timeline sequence", async () => {
    const { harness, spawn } = await loadAdvisor(`ADVISOR_RESULT
severity: nit
summary: Rename the helper
details:
- The current name is ambiguous.
END_ADVISOR_RESULT`);

    const first = await harness.callAgentTool(
      "advisor_review",
      { focus: "Review naming." },
      { threadId: "thread-primary" },
    );
    const second = await harness.callAgentTool(
      "advisor_review",
      { focus: "Review naming again." },
      { threadId: "thread-primary" },
    );

    expect(second).toBe(first);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(harness.sdk.callsTo("threads.output")).toHaveLength(1);
  });
});

describe("post-turn advisor", () => {
  it("carries an actionable completed-turn review into the next primary turn", async () => {
    const { harness } = await loadAutoAdvisor(`ADVISOR_RESULT
severity: blocker
summary: The claimed test did not run
details:
- Run the integration test and report its actual result.
END_ADVISOR_RESULT`);

    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        projectId: "project-test",
        environmentId: "environment-test",
        providerId: "codex",
        visibility: "visible",
      }),
      lastAssistantText: "Everything passes.",
    });

    const nextTurn = await harness.resolveAgentConfiguration(primaryContext);
    expect(nextTurn.instructions).toContain("late independent review");
    expect(nextTurn.instructions).toContain("The claimed test did not run");

    const followingTurn = await harness.resolveAgentConfiguration(primaryContext);
    expect(followingTurn.instructions).not.toContain("late independent review");
  });

  it("does not review hidden worker threads", async () => {
    const { harness, spawn } = await loadAutoAdvisor(`ADVISOR_RESULT
severity: pass
summary: Fine
details:
none
END_ADVISOR_RESULT`);

    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "hidden-worker",
        visibility: "hidden",
        originPluginId: "workflows",
      }),
      lastAssistantText: "Worker finished.",
    });

    expect(spawn).not.toHaveBeenCalled();
  });
});

const BLOCKER_OUTPUT = `ADVISOR_RESULT
severity: blocker
summary: The claimed test did not run
details:
- Run the integration test and report its actual result.
END_ADVISOR_RESULT`;

describe("manual advisor review", () => {
  it("returns started:false while a review is already in flight", async () => {
    const { harness } = await loadAdvisor(BLOCKER_OUTPUT);
    let releaseWait: (() => void) | undefined;
    const wait = vi.fn(
      async () =>
        await new Promise<{ matched: true }>((resolve) => {
          releaseWait = () => resolve({ matched: true });
        }),
    );
    harness.sdk.stub("threads.wait", wait);

    await expect(
      harness.callRpc("requestReview", { threadId: "thread-primary" }),
    ).resolves.toEqual({ started: true, waiting: false });
    await expect(
      harness.callRpc("requestReview", { threadId: "thread-primary" }),
    ).resolves.toEqual({ started: false, waiting: false });

    const during = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { reviewing: boolean };
    expect(during.reviewing).toBe(true);

    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(1));
    releaseWait!();
    await vi.waitFor(async () => {
      const after = (await harness.callRpc("threadReviews", {
        threadId: "thread-primary",
      })) as { reviewing: boolean; reviews: unknown[] };
      expect(after.reviewing).toBe(false);
      expect(after.reviews).toHaveLength(1);
    });

    const pending = (await harness.callRpc("pendingAdvice", {
      threadId: "thread-primary",
    })) as { advice: { severity: string } | null };
    expect(pending.advice?.severity).toBe("blocker");
  });

  it("waits for an active turn instead of reviewing an incomplete answer", async () => {
    const { harness } = await loadAdvisor(BLOCKER_OUTPUT);
    let primaryStatus: "active" | "idle" = "active";
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({
        id: threadId,
        projectId: "project-test",
        environmentId: "environment-test",
        providerId: "codex",
        visibility: threadId === "thread-primary" ? "visible" : "hidden",
        status: threadId === "thread-primary" ? primaryStatus : "idle",
      }),
    );

    await expect(
      harness.callRpc("requestReview", { threadId: "thread-primary" }),
    ).resolves.toEqual({ started: false, waiting: true });
    const waiting = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { lifecycle: string };
    expect(waiting.lifecycle).toBe("waiting");
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);

    primaryStatus = "idle";
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        visibility: "visible",
        status: "idle",
      }),
      lastAssistantText: "The completed public answer.",
    });
    const completed = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { lifecycle: string };
    expect(completed.lifecycle).toBe("changes-requested");
  });

  it("does not mistake an older output for completion of a cancelled latest turn", async () => {
    const { harness } = await loadAdvisor(BLOCKER_OUTPUT);
    harness.sdk.stub(
      "threads.timeline",
      async () =>
        ({
          rows: [
            {
              kind: "conversation",
              role: "assistant",
              turnId: "turn-1",
              text: "Older completed answer.",
            },
            {
              kind: "conversation",
              role: "user",
              turnId: "turn-2",
              text: "New request whose turn was cancelled.",
            },
          ],
          maxSeq: 43,
        }) as never,
    );

    await expect(
      harness.callRpc("requestReview", { threadId: "thread-primary" }),
    ).resolves.toEqual({ started: false, waiting: true });
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("settles a waiting review when the primary turn fails", async () => {
    const { harness } = await loadAdvisor(BLOCKER_OUTPUT);
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({
        id: threadId,
        projectId: "project-test",
        environmentId: "environment-test",
        providerId: "codex",
        visibility: threadId === "thread-primary" ? "visible" : "hidden",
        status: threadId === "thread-primary" ? "active" : "idle",
      }),
    );

    await expect(
      harness.callRpc("requestReview", { threadId: "thread-primary" }),
    ).resolves.toEqual({ started: false, waiting: true });
    await harness.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({
        id: "thread-primary",
        visibility: "visible",
        status: "idle",
      }),
      error: "provider stopped",
    });

    const settled = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { lifecycle: string; latestUnavailableReason: string | null };
    expect(settled.lifecycle).toBe("unavailable");
    expect(settled.latestUnavailableReason).toContain("primary turn failed");
  });

  it("settles a waiting review when idle arrives without a public answer", async () => {
    const { harness } = await loadAdvisor(BLOCKER_OUTPUT);
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({
        id: threadId,
        projectId: "project-test",
        environmentId: "environment-test",
        providerId: "codex",
        visibility: threadId === "thread-primary" ? "visible" : "hidden",
        status: threadId === "thread-primary" ? "active" : "idle",
      }),
    );

    await expect(
      harness.callRpc("requestReview", { threadId: "thread-primary" }),
    ).resolves.toEqual({ started: false, waiting: true });
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        visibility: "visible",
        status: "idle",
      }),
      lastAssistantText: null,
    });

    const settled = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { lifecycle: string; latestUnavailableReason: string | null };
    expect(settled.lifecycle).toBe("unavailable");
    expect(settled.latestUnavailableReason).toContain(
      "without a completed public answer",
    );
  });
});

describe("late-finding continuation", () => {
  it("starts one agent-only corrective turn and is idempotent per review round", async () => {
    const { harness } = await loadAutoAdvisor(BLOCKER_OUTPUT);
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        visibility: "visible",
      }),
      lastAssistantText: "Everything passes.",
    });
    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { id: number }[] };
    const reviewId = panel.reviews[0]!.id;

    await expect(
      harness.callRpc("continueFinding", {
        threadId: "thread-primary",
        reviewId,
      }),
    ).resolves.toEqual({ started: true, reason: "started" });
    await expect(
      harness.callRpc("continueFinding", {
        threadId: "thread-primary",
        reviewId,
      }),
    ).resolves.toEqual({ started: false, reason: "already-started" });

    const primarySends = harness.sdk
      .callsTo("threads.send")
      .filter(
        ([call]) =>
          (call as { threadId: string }).threadId === "thread-primary",
      );
    expect(primarySends).toHaveLength(1);
    expect(primarySends[0]?.[0]).toMatchObject({
      mode: "queue-if-active",
      input: [
        expect.objectContaining({
          visibility: "agent-only",
          text: expect.stringContaining("requested changes"),
        }),
      ],
    });
    const pending = (await harness.callRpc("pendingAdvice", {
      threadId: "thread-primary",
    })) as { advice: unknown };
    expect(pending.advice).toBeNull();
  });

  it("auto-continues at most once for a persistent finding chain", async () => {
    const { harness, setTimelineSeq } = await loadAutoAdvisor(BLOCKER_OUTPUT);
    await harness.setSettings({ autoContinue: true });

    const idle = () =>
      harness.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({
          id: "thread-primary",
          visibility: "visible",
        }),
        lastAssistantText: "Done.",
      });
    await idle();
    setTimelineSeq(43);
    await idle();

    const primarySends = harness.sdk
      .callsTo("threads.send")
      .filter(
        ([call]) =>
          (call as { threadId: string }).threadId === "thread-primary",
      );
    expect(primarySends).toHaveLength(1);
  });
});

describe("pending finding queue", () => {
  const finding = (
    severity: "concern" | "blocker",
    key: string,
    summary: string,
  ) => `ADVISOR_RESULT
severity: ${severity}
key: ${key}
summary: ${summary}
details:
- Correct ${key}.
resolved: none
END_ADVISOR_RESULT`;

  it("carries every queued finding into the next turn and marks each sent", async () => {
    const { harness, setTimelineSeq, setAdvisorOutput } = await loadAutoAdvisor(
      finding("blocker", "first-open", "First queued finding"),
    );
    const idle = (text: string) =>
      harness.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({
          id: "thread-primary",
          visibility: "visible",
        }),
        lastAssistantText: text,
      });

    await idle("First turn.");
    setTimelineSeq(43);
    setAdvisorOutput(
      finding("concern", "second-open", "Second queued finding"),
    );
    await idle("Second turn.");

    const nextTurn = await harness.resolveAgentConfiguration(primaryContext);
    expect(nextTurn.instructions).toContain("First queued finding");
    expect(nextTurn.instructions).toContain("Second queued finding");

    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { summary: string; sentAt: number | null }[] };
    expect(
      panel.reviews
        .filter((review) => review.summary.includes("queued finding"))
        .map((review) => review.sentAt),
    ).toEqual([expect.any(Number), expect.any(Number)]);

    const followingTurn = await harness.resolveAgentConfiguration(primaryContext);
    expect(followingTurn.instructions).not.toContain("queued finding");
  });

  it("does not bulk-retire an older finding when a tool review returns another", async () => {
    const { harness, setTimelineSeq, setAdvisorOutput } = await loadAutoAdvisor(
      finding("blocker", "older-open", "Older queued finding"),
    );
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        visibility: "visible",
      }),
      lastAssistantText: "First turn.",
    });

    setTimelineSeq(43);
    setAdvisorOutput(
      finding("concern", "current-tool", "Current tool finding"),
    );
    expect(
      await harness.callAgentTool(
        "advisor_review",
        { focus: "Review current work." },
        { threadId: "thread-primary" },
      ),
    ).toContain("Current tool finding");

    const pending = (await harness.callRpc("pendingAdvice", {
      threadId: "thread-primary",
    })) as { advice: { summary: string } | null };
    expect(pending.advice?.summary).toBe("Older queued finding");
    const nextTurn = await harness.resolveAgentConfiguration(primaryContext);
    expect(nextTurn.instructions).toContain("Older queued finding");
  });
});

describe("repeated advice", () => {
  it("keeps the severity of an unresolved repeat instead of passing it", async () => {
    const { harness, setTimelineSeq } = await loadAdvisor(BLOCKER_OUTPUT);

    const first = await harness.callAgentTool(
      "advisor_review",
      { focus: "First review." },
      { threadId: "thread-primary" },
    );
    setTimelineSeq(43);
    const second = await harness.callAgentTool(
      "advisor_review",
      { focus: "Second review after ignoring the advice." },
      { threadId: "thread-primary" },
    );

    expect(first).toContain("Advisor blocker: The claimed test did not run");
    expect(second).toContain("Advisor blocker: The claimed test did not run");
    expect(second).not.toContain("Advisor pass");
    expect(second).toContain("still unresolved");
  });
});

describe("advisor session environment binding", () => {
  it("falls back to accept-edits on a bb without a read-only mode", async () => {
    // The mode is negotiated, not pinned: pinning read-only would report every
    // review unavailable on a bb that predates it.
    const { harness, spawn } = await loadAdvisor(BLOCKER_OUTPUT);
    harness.sdk.stub("providers.models", async () => ({
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          available: true,
          capabilities: {
            supportedPermissionModes: ["accept-edits", "auto", "full"],
          },
        },
      ],
      models: [],
      modelLoadError: null,
    }));

    await harness.callAgentTool(
      "advisor_review",
      { focus: "Review on a bb without read-only." },
      { threadId: "thread-primary" },
    );

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "accept-edits" }),
    );
  });

  it("respawns the reviewer once a narrower mode becomes available", async () => {
    // Reusing the old session after a bb upgrade would quietly keep the
    // reviewer's workspace write access.
    let modes = ["accept-edits", "auto", "full"];
    const { harness, spawn, setTimelineSeq } = await loadAdvisor(BLOCKER_OUTPUT);
    harness.sdk.stub("providers.models", async () => ({
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          available: true,
          capabilities: { supportedPermissionModes: modes },
        },
      ],
      models: [],
      modelLoadError: null,
    }));

    await harness.callAgentTool(
      "advisor_review",
      { focus: "Before the upgrade." },
      { threadId: "thread-primary" },
    );
    expect(spawn).toHaveBeenCalledTimes(1);

    modes = ["readonly", "accept-edits", "auto", "full"];
    setTimelineSeq(43);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "After the upgrade." },
      { threadId: "thread-primary" },
    );

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionMode: "readonly" }),
    );
  });

  it("probes narrowest-first when the catalog cannot be read", async () => {
    // A transient catalog outage must not disable reviews, and must not
    // silently hand the reviewer a wider mode than the host would have.
    const attempted: string[] = [];
    const { harness } = await loadAdvisor(BLOCKER_OUTPUT);
    harness.sdk.stub("providers.models", async () => {
      throw new Error("catalog unavailable");
    });
    harness.sdk.stub("threads.spawn", async (args: { permissionMode: string }) => {
      attempted.push(args.permissionMode);
      if (args.permissionMode === "readonly") {
        throw new Error("unsupported permission mode");
      }
      return makeThreadResponse({
        id: "thread-advisor",
        projectId: "project-test",
        environmentId: "environment-test",
        providerId: "codex",
        originPluginId: "advisor",
        visibility: "hidden",
        status: "active",
      });
    });

    await harness.callAgentTool(
      "advisor_review",
      { focus: "Review during a catalog outage." },
      { threadId: "thread-primary" },
    );

    // Read-only was asked for first and only refused, never assumed away.
    expect(attempted).toEqual(["readonly", "accept-edits"]);
  });

  it("respawns the reviewer when the primary thread changes environment", async () => {
    const { harness, spawn, setTimelineSeq } = await loadAdvisor(BLOCKER_OUTPUT);

    await harness.callAgentTool(
      "advisor_review",
      { focus: "Review in the original environment." },
      { threadId: "thread-primary" },
    );
    expect(spawn).toHaveBeenCalledTimes(1);

    await harness.resolveAgentConfiguration({
      ...primaryContext,
      environment: { ...primaryContext.environment, id: "environment-moved" },
    });
    setTimelineSeq(43);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Review after moving the thread." },
      { threadId: "thread-primary" },
    );

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        environment: { type: "reuse", environmentId: "environment-moved" },
      }),
    );
  });
});

describe("advisor unavailability", () => {
  it("reports unavailable when the primary provider cannot host a reviewer", async () => {
    const { harness, spawn } = await loadAdvisor(BLOCKER_OUTPUT);
    harness.sdk.stub("providers.models", async () => ({
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          available: true,
          capabilities: { supportedPermissionModes: ["full"] },
        },
      ],
      models: [],
      modelLoadError: null,
    }));

    const result = await harness.callAgentTool(
      "advisor_review",
      { focus: "Review on an incompatible provider." },
      { threadId: "thread-primary" },
    );

    expect(result).toContain("Advisor unavailable");
    expect(result).toContain("cannot host a reviewer");
    expect(result).toContain("read-only");
    expect(result).toContain("NOT an approval");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports a timeout as unavailable rather than throwing or passing", async () => {
    const { harness } = await loadAdvisor(BLOCKER_OUTPUT);
    const stop = vi.fn(async () => ({ ok: true }));
    harness.sdk.stub("threads.stop", stop);
    harness.sdk.stub("threads.wait", async () => {
      throw new Error("ThreadWaitTimeoutError: timed out");
    });

    const result = await harness.callAgentTool(
      "advisor_review",
      { focus: "Review that never finishes." },
      { threadId: "thread-primary" },
    );

    expect(result).toContain("Advisor unavailable");
    expect(result).toContain("did not finish within");
    expect(result).not.toContain("Advisor pass");
    expect(stop).toHaveBeenCalledWith({ threadId: "thread-advisor" });
  });

  it("stops the reviewer when the primary turn is cancelled", async () => {
    const { harness } = await loadAdvisor(BLOCKER_OUTPUT);
    const controller = new AbortController();
    const stop = vi.fn(async () => ({ ok: true }));
    harness.sdk.stub("threads.stop", stop);
    harness.sdk.stub("threads.wait", async () => {
      controller.abort();
      throw new Error("aborted");
    });

    const result = await harness.callAgentTool(
      "advisor_review",
      { focus: "Review interrupted by the user." },
      { threadId: "thread-primary", signal: controller.signal },
    );

    expect(result).toContain("Advisor unavailable");
    expect(result).toContain("cancelled");
    expect(stop).toHaveBeenCalledWith({ threadId: "thread-advisor" });
  });

  it("leaves pending advice undelivered when the advisor could not run", async () => {
    const { harness, setTimelineSeq } = await loadAutoAdvisor(BLOCKER_OUTPUT);
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        projectId: "project-test",
        environmentId: "environment-test",
        providerId: "codex",
        visibility: "visible",
      }),
      lastAssistantText: "Everything passes.",
    });
    // A later turn, so the tool runs a fresh review instead of reusing the
    // post-turn review already cached for sequence 42.
    setTimelineSeq(43);
    harness.sdk.stub("threads.wait", async () => {
      throw new Error("ThreadWaitTimeoutError: timed out");
    });

    const result = await harness.callAgentTool(
      "advisor_review",
      { focus: "Review that times out." },
      { threadId: "thread-primary" },
    );
    expect(result).toContain("Advisor unavailable");

    const nextTurn = await harness.resolveAgentConfiguration(primaryContext);
    expect(nextTurn.instructions).toContain("The claimed test did not run");
  });
});

describe("post-turn review scope", () => {
  it("skips a visible thread owned by another plugin", async () => {
    const { harness, spawn } = await loadAutoAdvisor(BLOCKER_OUTPUT);

    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "workflow-thread",
        projectId: "project-test",
        environmentId: "environment-test",
        providerId: "codex",
        visibility: "visible",
        originPluginId: "workflows",
      }),
      lastAssistantText: "Workflow finished.",
    });

    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not hand a later turn the review of an earlier one", async () => {
    const { harness, setTimelineSeq } = await loadAutoAdvisor(BLOCKER_OUTPUT);
    let releaseFirstWait: () => void = () => {};
    let waits = 0;
    harness.sdk.stub("threads.wait", async () => {
      waits += 1;
      if (waits === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstWait = resolve;
        });
      }
      return { matched: true };
    });

    const postTurn = harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        projectId: "project-test",
        environmentId: "environment-test",
        providerId: "codex",
        visibility: "visible",
      }),
      lastAssistantText: "Turn one done.",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The next turn starts while the post-turn review of turn one is still running.
    setTimelineSeq(43);
    const toolResult = harness.callAgentTool(
      "advisor_review",
      { focus: "Review turn two." },
      { threadId: "thread-primary" },
    );
    releaseFirstWait();
    await postTurn;

    // A second review really ran, and it is the later turn's own review — a
    // joined earlier-turn review would not be recorded as a repeat.
    expect(harness.sdk.callsTo("threads.output")).toHaveLength(2);
    expect(await toolResult).toContain("still unresolved");
  });

  it("does not re-review a turn the advisor tool already reviewed", async () => {
    const { harness, setTimelineSeq } = await loadAutoAdvisor(BLOCKER_OUTPUT);

    await harness.callAgentTool(
      "advisor_review",
      { focus: "Reviewed during the turn." },
      { threadId: "thread-primary" },
    );
    setTimelineSeq(43);
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        projectId: "project-test",
        environmentId: "environment-test",
        providerId: "codex",
        visibility: "visible",
      }),
      lastAssistantText: "Done.",
    });

    expect(harness.sdk.callsTo("threads.output")).toHaveLength(1);
  });

  it("clears the tool-review suppression flag while auto-review is off", async () => {
    const { harness, setTimelineSeq } = await loadAdvisor(BLOCKER_OUTPUT);

    await harness.callAgentTool(
      "advisor_review",
      { focus: "Reviewed while auto-review is disabled." },
      { threadId: "thread-primary" },
    );
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        visibility: "visible",
      }),
      lastAssistantText: "First turn done.",
    });

    await harness.setSettings({ autoReview: true });
    setTimelineSeq(43);
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        visibility: "visible",
      }),
      lastAssistantText: "Second turn done.",
    });

    expect(harness.sdk.callsTo("threads.output")).toHaveLength(2);
  });
});

describe("thread surfaces", () => {
  it("collapses a repeat chain into one row carrying its count and origin", async () => {
    const { harness, setTimelineSeq } = await loadAdvisor(BLOCKER_OUTPUT);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "First." },
      { threadId: "thread-primary" },
    );
    setTimelineSeq(43);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Second." },
      { threadId: "thread-primary" },
    );

    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as {
      reviews: {
        severity: string;
        repeatCount: number;
        firstSourceSeq: number;
        sourceSeq: number;
        model: string;
      }[];
      advisorThreadId: string | null;
    };

    expect(panel.reviews).toHaveLength(1);
    expect(panel.reviews[0]).toMatchObject({
      severity: "blocker",
      repeatCount: 2,
      firstSourceSeq: 42,
      sourceSeq: 43,
      model: "gpt-5.6",
    });
    expect(panel.advisorThreadId).toBe("thread-advisor");

    const badge = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { latest: { severity: string; repeatCount: number } | null };
    expect(badge.latest).toMatchObject({ severity: "blocker", repeatCount: 2 });
  });

  it("keeps an open blocker in the badge after a later passing verdict", async () => {
    let output = BLOCKER_OUTPUT;
    const { harness, setTimelineSeq } = await loadAdvisor(output);
    harness.sdk.stub("threads.output", async () => ({ output }));

    await harness.callAgentTool(
      "advisor_review",
      { focus: "First review." },
      { threadId: "thread-primary" },
    );
    output = `ADVISOR_RESULT
severity: pass
key: none
summary: Latest work looks correct
details:
none
END_ADVISOR_RESULT`;
    setTimelineSeq(43);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Later review." },
      { threadId: "thread-primary" },
    );

    const badge = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as {
      open: { severity: string; summary: string } | null;
      latest: { severity: string; summary: string } | null;
    };
    expect(badge.open).toMatchObject({
      severity: "blocker",
      summary: "The claimed test did not run",
    });
    expect(badge.latest).toMatchObject({
      severity: "pass",
      summary: "Latest work looks correct",
    });
  });

  it("records a failed review as an incident, never as a verdict", async () => {
    const { harness } = await loadAdvisor(BLOCKER_OUTPUT);
    harness.sdk.stub("threads.wait", async () => {
      throw new Error("ThreadWaitTimeoutError: timed out");
    });

    await harness.callAgentTool(
      "advisor_review",
      { focus: "Times out." },
      { threadId: "thread-primary" },
    );

    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: unknown[]; incidents: { reason: string }[] };
    expect(panel.reviews).toHaveLength(0);
    expect(panel.incidents).toHaveLength(1);
    expect(panel.incidents[0]?.reason).toContain("did not finish within");

    const badge = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { latest: unknown; unavailableCount: number };
    expect(badge.latest).toBeNull();
    expect(badge.unavailableCount).toBe(1);
  });

  it("exposes pending advice to the composer and retires it on dismiss", async () => {
    const { harness } = await loadAutoAdvisor(BLOCKER_OUTPUT);
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        projectId: "project-test",
        environmentId: "environment-test",
        providerId: "codex",
        visibility: "visible",
      }),
      lastAssistantText: "Everything passes.",
    });

    const before = (await harness.callRpc("pendingAdvice", {
      threadId: "thread-primary",
    })) as { advice: { id: number; summary: string } | null };
    expect(before.advice?.summary).toBe("The claimed test did not run");

    await harness.callRpc("dismissAdvice", {
      threadId: "thread-primary",
      adviceId: before.advice!.id,
    });

    const after = (await harness.callRpc("pendingAdvice", {
      threadId: "thread-primary",
    })) as { advice: unknown };
    expect(after.advice).toBeNull();

    // Dismissing must retire the advice, not defer it to the next turn.
    const nextTurn = await harness.resolveAgentConfiguration(primaryContext);
    expect(nextTurn.instructions).not.toContain("late independent review");
  });

  it("resolves a chain, removes it from the badge, and clears pending advice", async () => {
    const { harness } = await loadAutoAdvisor(BLOCKER_OUTPUT);
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        visibility: "visible",
      }),
      lastAssistantText: "Everything passes.",
    });
    const before = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as {
      reviews: { chainId: number; resolvedAt: number | null }[];
    };

    await expect(
      harness.callRpc("resolveFinding", {
        threadId: "thread-primary",
        chainId: before.reviews[0]!.chainId,
        resolved: true,
        reason: "The advisor misread the test output.",
      }),
    ).resolves.toEqual({ ok: true, resolved: true });

    const badge = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { open: unknown };
    const pending = (await harness.callRpc("pendingAdvice", {
      threadId: "thread-primary",
    })) as { advice: unknown };
    const after = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as {
      reviews: { resolvedAt: number | null; resolvedReason: string }[];
    };
    expect(badge.open).toBeNull();
    expect(pending.advice).toBeNull();
    expect(after.reviews[0]?.resolvedAt).toEqual(expect.any(Number));
    expect(after.reviews[0]?.resolvedReason).toBe(
      "The advisor misread the test output.",
    );

    const nextTurn = await harness.resolveAgentConfiguration(primaryContext);
    expect(nextTurn.instructions).not.toContain("late independent review");
  });

  it("records what the user decided, and reopening clears every trace", async () => {
    const { harness } = await loadAutoAdvisor(BLOCKER_OUTPUT);
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        visibility: "visible",
      }),
      lastAssistantText: "Everything passes.",
    });
    const before = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { chainId: number }[] };
    const chainId = before.reviews[0]!.chainId;

    // Users may overrule a finding, but cannot self-certify a fix.
    await harness.callRpc("resolveFinding", {
      threadId: "thread-primary",
      chainId,
      resolved: true,
      reason: "The finding does not apply here.",
      decision: "not-an-issue",
    });
    const decided = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { decision: string; resolvedAt: number | null }[] };
    expect(decided.reviews[0]?.decision).toBe("not-an-issue");

    await harness.callRpc("resolveFinding", {
      threadId: "thread-primary",
      chainId,
      resolved: false,
    });
    const reopened = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as {
      reviews: {
        decision: string;
        resolvedAt: number | null;
        resolvedReason: string;
        closedAt: number | null;
        closedSeq: number | null;
      }[];
    };
    expect(reopened.reviews[0]).toMatchObject({
      decision: "",
      resolvedAt: null,
      resolvedReason: "",
      closedAt: null,
      closedSeq: null,
    });
  });

  it("marks a finding sent only when it actually reaches the agent", async () => {
    const { harness } = await loadAutoAdvisor(BLOCKER_OUTPUT);
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        visibility: "visible",
      }),
      lastAssistantText: "Everything passes.",
    });
    const queued = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { sentAt: number | null }[] };
    // Found but not yet handed over: the bulk pending sweep must not claim it.
    expect(queued.reviews[0]?.sentAt).toBeNull();

    await harness.resolveAgentConfiguration(primaryContext);
    const sent = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { sentAt: number | null }[] };
    expect(sent.reviews[0]?.sentAt).toEqual(expect.any(Number));
  });

  it("closes a finding the advisor says it verified, and reopens it on regression", async () => {
    const keyed = (severity: string, resolved: string) => `ADVISOR_RESULT
severity: ${severity}
key: missing-test-run
summary: The claimed test did not run
details:
- Run the integration test and report its actual result.
resolved: ${resolved}
END_ADVISOR_RESULT`;

    const { harness, setTimelineSeq, setAdvisorOutput } =
      await loadAdvisor(keyed("blocker", "none"));
    await harness.callAgentTool(
      "advisor_review",
      { focus: "First pass." },
      { threadId: "thread-primary" },
    );
    const raised = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { open: { chainId: number } | null };
    expect(raised.open).not.toBeNull();

    // A later review states it re-checked that key and it is now addressed.
    setTimelineSeq(43);
    setAdvisorOutput(`ADVISOR_RESULT
severity: pass
key: none
summary: All clear
details:
- none
resolved: missing-test-run
END_ADVISOR_RESULT`);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Second pass." },
      { threadId: "thread-primary" },
    );
    const closed = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { open: unknown };
    const closedRows = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { closedAt: number | null; closedSeq: number | null }[] };
    expect(closed.open).toBeNull();
    expect(
      closedRows.reviews.some(
        (row) => row.closedAt !== null && row.closedSeq === 43,
      ),
    ).toBe(true);

    // Then the same defect comes back. An advisor closure is provisional, so
    // a regression must resurface rather than stay quietly closed.
    setTimelineSeq(44);
    setAdvisorOutput(keyed("blocker", "none"));
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Third pass." },
      { threadId: "thread-primary" },
    );
    const regressed = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { open: { severity: string } | null };
    expect(regressed.open?.severity).toBe("blocker");
  });

  it("ignores a close for a key that is not open on the thread", async () => {
    // Otherwise an advisor could retire findings it never raised or checked.
    const { harness } = await loadAdvisor(`ADVISOR_RESULT
severity: blocker
key: real-defect
summary: The claimed test did not run
details:
- Run it.
resolved: some-other-thread-key, real-defect
END_ADVISOR_RESULT`);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Only pass." },
      { threadId: "thread-primary" },
    );

    // Including its own key must not let it raise and close in one breath.
    const badge = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { open: { severity: string } | null };
    expect(badge.open?.severity).toBe("blocker");
  });

  it("records a repeat on a resolved chain without resurfacing it", async () => {
    const { harness, setTimelineSeq } = await loadAutoAdvisor(BLOCKER_OUTPUT);
    const thread = makeThreadResponse({
      id: "thread-primary",
      visibility: "visible",
    });
    await harness.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "First turn done.",
    });
    const first = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { chainId: number }[] };
    await harness.callRpc("resolveFinding", {
      threadId: "thread-primary",
      chainId: first.reviews[0]!.chainId,
      resolved: true,
      reason: "False positive.",
    });

    setTimelineSeq(43);
    await harness.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "Second turn done.",
    });

    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as {
      reviews: { repeatCount: number; resolvedAt: number | null }[];
    };
    const badge = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { open: unknown };
    const pending = (await harness.callRpc("pendingAdvice", {
      threadId: "thread-primary",
    })) as { advice: unknown };
    expect(panel.reviews[0]).toMatchObject({ repeatCount: 2 });
    expect(panel.reviews[0]?.resolvedAt).toEqual(expect.any(Number));
    expect(badge.open).toBeNull();
    expect(pending.advice).toBeNull();
    expect(
      (await harness.resolveAgentConfiguration(primaryContext)).instructions,
    ).not.toContain("late independent review");
  });

  it("reopens a resolved chain", async () => {
    const { harness } = await loadAdvisor(BLOCKER_OUTPUT);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Review." },
      { threadId: "thread-primary" },
    );
    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { chainId: number }[] };
    const chainId = panel.reviews[0]!.chainId;
    await harness.callRpc("resolveFinding", {
      threadId: "thread-primary",
      chainId,
      resolved: true,
      reason: "Override.",
    });

    await expect(
      harness.callRpc("resolveFinding", {
        threadId: "thread-primary",
        chainId,
        resolved: false,
      }),
    ).resolves.toEqual({ ok: true, resolved: false });

    const badge = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { open: { chainId: number; severity: string } | null };
    const reopened = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as {
      reviews: { resolvedAt: number | null; resolvedReason: string }[];
    };
    expect(badge.open).toMatchObject({ chainId, severity: "blocker" });
    expect(reopened.reviews[0]).toMatchObject({
      resolvedAt: null,
      resolvedReason: "",
    });
  });
});

const NIT_REPEAT_OUTPUT = `ADVISOR_RESULT
severity: nit
summary: The claimed test did not run
details:
- Run the integration test and report its actual result.
END_ADVISOR_RESULT`;

describe("review-workflow regressions", () => {
  it("does not let a reworded repeat soften an unresolved finding", async () => {
    let output = BLOCKER_OUTPUT;
    const { harness, setTimelineSeq } = await loadAdvisor(BLOCKER_OUTPUT);
    harness.sdk.stub("threads.output", async () => ({ output }));

    await harness.callAgentTool(
      "advisor_review",
      { focus: "First." },
      { threadId: "thread-primary" },
    );
    // Same advice, restated as a nit. normalizeAdvice ignores severity, so this
    // matches the chain and must not downgrade it.
    output = NIT_REPEAT_OUTPUT;
    setTimelineSeq(43);
    const second = await harness.callAgentTool(
      "advisor_review",
      { focus: "Second." },
      { threadId: "thread-primary" },
    );

    expect(second).toContain("Advisor blocker:");
    expect(second).not.toContain("Advisor nit:");

    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { severity: string; repeatCount: number }[] };
    expect(panel.reviews[0]).toMatchObject({
      severity: "blocker",
      repeatCount: 2,
    });
  });

  it("chains a short reworded finding by key and keeps its severity", async () => {
    let output = `ADVISOR_RESULT
severity: blocker
key: server-ts-timeout-untested
summary: Timeout untested
details:
- Add a test.
END_ADVISOR_RESULT`;
    const { harness, setTimelineSeq } = await loadAdvisor(output);
    harness.sdk.stub("threads.output", async () => ({ output }));

    await harness.callAgentTool(
      "advisor_review",
      { focus: "First." },
      { threadId: "thread-primary" },
    );

    // Same defect, different wording, softer severity, and short enough that
    // text matching would never have chained it.
    output = `ADVISOR_RESULT
severity: nit
key: server-ts-timeout-untested
summary: Maybe cover the timeout
details:
- Optional.
END_ADVISOR_RESULT`;
    setTimelineSeq(43);
    const second = await harness.callAgentTool(
      "advisor_review",
      { focus: "Second." },
      { threadId: "thread-primary" },
    );

    expect(second).toContain("Advisor blocker:");
    expect(second).toContain("still unresolved");

    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { severity: string; repeatCount: number }[] };
    expect(panel.reviews).toHaveLength(1);
    expect(panel.reviews[0]).toMatchObject({
      severity: "blocker",
      repeatCount: 2,
    });
  });

  it("chains a keyed finding onto a legacy keyless one instead of softening it", async () => {
    const body = `summary: The claimed integration test did not run at all
details:
- Run the focused integration test and report its actual output.`;
    let output = `ADVISOR_RESULT
severity: blocker
${body}
END_ADVISOR_RESULT`;
    const { harness, setTimelineSeq } = await loadAdvisor(output);
    harness.sdk.stub("threads.output", async () => ({ output }));

    // Round one predates keys, exactly like every row already in the database.
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Legacy round." },
      { threadId: "thread-primary" },
    );

    // Round two carries a key and a softer severity. It must still find the
    // legacy chain through the text fallback.
    output = `ADVISOR_RESULT
severity: nit
key: server-ts-integration-test-not-run
${body}
END_ADVISOR_RESULT`;
    setTimelineSeq(43);
    const second = await harness.callAgentTool(
      "advisor_review",
      { focus: "Keyed round." },
      { threadId: "thread-primary" },
    );

    expect(second).toContain("Advisor blocker:");
    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { severity: string; repeatCount: number }[] };
    expect(panel.reviews).toHaveLength(1);
    expect(panel.reviews[0]).toMatchObject({
      severity: "blocker",
      repeatCount: 2,
    });
  });

  it("withholds findings below the configured threshold from the tool too", async () => {
    const { harness } = await loadAdvisor(`ADVISOR_RESULT
severity: nit
key: some-minor-thing
summary: Rename a helper for clarity
details:
- Cosmetic only.
END_ADVISOR_RESULT`);
    await harness.setSettings({ severityThreshold: "blocker" });

    const result = await harness.callAgentTool(
      "advisor_review",
      { focus: "Review." },
      { threadId: "thread-primary" },
    );
    expect(result).toContain("Advisor pass");
    expect(result).not.toContain("Rename a helper");
  });

  it("treats a reply with no verdict as the advisor not having run", async () => {
    const { harness } = await loadAdvisor("I had a look and it seems fine.");

    const result = await harness.callAgentTool(
      "advisor_review",
      { focus: "Review." },
      { threadId: "thread-primary" },
    );
    expect(result).toContain("Advisor unavailable");
    expect(result).toContain("no verdict");
    expect(result).not.toContain("Advisor concern");

    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: unknown[]; incidents: unknown[] };
    expect(panel.reviews).toHaveLength(0);
    expect(panel.incidents).toHaveLength(1);
  });

  it("keeps review history when a thread is archived, drops it when deleted", async () => {
    const { harness } = await loadAdvisor(BLOCKER_OUTPUT);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Review." },
      { threadId: "thread-primary" },
    );
    expect(
      ((await harness.callRpc("threadReviews", {
        threadId: "thread-primary",
      })) as { reviews: unknown[] }).reviews,
    ).toHaveLength(1);

    const archivedThread = makeThreadResponse({
      id: "thread-primary",
      projectId: "project-test",
      environmentId: "environment-test",
      providerId: "codex",
      visibility: "visible",
    });

    // Archiving is reversible, so the history must survive it.
    await harness.emitThreadEvent("thread.archived", { thread: archivedThread });
    const archived = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: unknown[] };
    expect(archived.reviews).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.archive")).toEqual([
      [{ threadId: "thread-advisor" }],
    ]);

    // Deletion is not reversible, so it takes the advisor state with it.
    await harness.emitThreadEvent("thread.deleted", { thread: archivedThread });
    const deleted = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: unknown[]; advisorThreadId: string | null };
    expect(deleted.reviews).toHaveLength(0);
    expect(deleted.advisorThreadId).toBeNull();
  });

  it("refuses to dismiss advice the banner never showed", async () => {
    const { harness } = await loadAutoAdvisor(BLOCKER_OUTPUT);
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thread-primary",
        projectId: "project-test",
        environmentId: "environment-test",
        providerId: "codex",
        visibility: "visible",
      }),
      lastAssistantText: "Done.",
    });

    const pending = (await harness.callRpc("pendingAdvice", {
      threadId: "thread-primary",
    })) as { advice: { id: number } | null };

    // A stale click carrying an older advice id must not retire the current one.
    const result = (await harness.callRpc("dismissAdvice", {
      threadId: "thread-primary",
      adviceId: pending.advice!.id - 1,
    })) as { dismissed: boolean };
    expect(result.dismissed).toBe(false);

    const still = (await harness.callRpc("pendingAdvice", {
      threadId: "thread-primary",
    })) as { advice: unknown };
    expect(still.advice).not.toBeNull();

    const nextTurn = await harness.resolveAgentConfiguration(primaryContext);
    expect(nextTurn.instructions).toContain("The claimed test did not run");
  });

  it("records an incident when the transcript cannot be read", async () => {
    const { harness } = await loadAdvisor(BLOCKER_OUTPUT);
    harness.sdk.stub("threads.timeline", async () => {
      throw new Error("transcript unavailable");
    });

    const result = await harness.callAgentTool(
      "advisor_review",
      { focus: "Timeline fails." },
      { threadId: "thread-primary" },
    );
    expect(result).toContain("Advisor unavailable");
    expect(result).toContain("NOT an approval");

    // The failure must reach the panel, not vanish into a thrown tool error.
    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { incidents: { reason: string }[] };
    expect(panel.incidents).toHaveLength(1);
    expect(panel.incidents[0]?.reason).toContain("transcript could not be read");
  });

  it("stops advertising an older verdict once a later review fails", async () => {
    const { harness, setTimelineSeq } = await loadAdvisor(`ADVISOR_RESULT
severity: pass
summary: All good
details:
none
END_ADVISOR_RESULT`);

    await harness.callAgentTool(
      "advisor_review",
      { focus: "Passing review." },
      { threadId: "thread-primary" },
    );
    const passing = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { latest: { severity: string } | null; latestIsUnavailable: boolean };
    expect(passing.latest?.severity).toBe("pass");
    expect(passing.latestIsUnavailable).toBe(false);

    setTimelineSeq(43);
    harness.sdk.stub("threads.wait", async () => {
      throw new Error("ThreadWaitTimeoutError: timed out");
    });
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Failing review." },
      { threadId: "thread-primary" },
    );

    const after = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { latestIsUnavailable: boolean; unavailableCount: number };
    expect(after.latestIsUnavailable).toBe(true);
    expect(after.unavailableCount).toBe(1);
  });

  it("attributes each review to the reviewer thread that produced it", async () => {
    const { harness } = await loadAdvisor(BLOCKER_OUTPUT);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Review." },
      { threadId: "thread-primary" },
    );

    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { advisorThreadId: string | null }[] };
    expect(panel.reviews[0]?.advisorThreadId).toBe("thread-advisor");
  });
});

describe("rpc boundary and isolation", () => {
  it("rejects malformed input and isolates threads from each other", async () => {
    const { harness, setTimelineSeq } = await loadAdvisor(BLOCKER_OUTPUT);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Review thread one." },
      { threadId: "thread-primary" },
    );

    await expect(
      harness.callRpc("threadReviews", { threadId: "" }),
    ).rejects.toThrow();
    await expect(
      harness.callRpc("threadReviews", {
        threadId: "thread-primary",
        extra: true,
      }),
    ).rejects.toThrow();
    await expect(
      harness.callRpc("dismissAdvice", { threadId: "thread-primary" }),
    ).rejects.toThrow();

    const owned = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { chainId: number }[] };
    await expect(
      harness.callRpc("resolveFinding", {
        threadId: "thread-other",
        chainId: owned.reviews[0]!.chainId,
        resolved: true,
        reason: "Cross-thread attempt.",
      }),
    ).resolves.toEqual({ ok: true, resolved: false });
    const isolated = (await harness.callRpc("threadBadge", {
      threadId: "thread-primary",
    })) as { open: { chainId: number } | null };
    expect(isolated.open?.chainId).toBe(owned.reviews[0]!.chainId);

    // An unknown thread is empty, never another thread's history.
    const unknown = (await harness.callRpc("threadReviews", {
      threadId: "thread-does-not-exist",
    })) as { reviews: unknown[]; incidents: unknown[]; advisorThreadId: null };
    expect(unknown.reviews).toHaveLength(0);
    expect(unknown.incidents).toHaveLength(0);
    expect(unknown.advisorThreadId).toBeNull();

    setTimelineSeq(43);
    await harness.resolveAgentConfiguration({
      ...primaryContext,
      thread: { ...primaryContext.thread, id: "thread-other" },
    });
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Review thread two." },
      { threadId: "thread-other" },
    );
    const first = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: unknown[] };
    const second = (await harness.callRpc("threadReviews", {
      threadId: "thread-other",
    })) as { reviews: unknown[] };
    expect(first.reviews).toHaveLength(1);
    expect(second.reviews).toHaveLength(1);
  });

  it("does not chain terse advice that merely repeats generic wording", async () => {
    const terse = `ADVISOR_RESULT
severity: nit
summary: Rename it
details:
none
END_ADVISOR_RESULT`;
    const { harness, setTimelineSeq } = await loadAdvisor(terse);

    await harness.callAgentTool(
      "advisor_review",
      { focus: "First." },
      { threadId: "thread-primary" },
    );
    setTimelineSeq(43);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Second." },
      { threadId: "thread-primary" },
    );

    // Two separate findings, not one chain that could inherit a severity.
    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { repeatCount: number; chainId: number }[] };
    expect(panel.reviews).toHaveLength(2);
    expect(panel.reviews.every((review) => review.repeatCount === 1)).toBe(true);
  });

  it("keeps a chain id stable across repeat rounds", async () => {
    const { harness, setTimelineSeq } = await loadAdvisor(BLOCKER_OUTPUT);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "First." },
      { threadId: "thread-primary" },
    );
    const before = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { id: number; chainId: number }[] };

    setTimelineSeq(43);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Second." },
      { threadId: "thread-primary" },
    );
    const after = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { reviews: { id: number; chainId: number }[] };

    expect(after.reviews[0]?.chainId).toBe(before.reviews[0]?.chainId);
    expect(after.reviews[0]?.id).not.toBe(before.reviews[0]?.id);
  });

  it("caps stored incidents per thread", async () => {
    const { harness, setTimelineSeq } = await loadAdvisor(BLOCKER_OUTPUT);
    harness.sdk.stub("threads.wait", async () => {
      throw new Error("ThreadWaitTimeoutError: timed out");
    });
    for (let seq = 100; seq < 155; seq += 1) {
      setTimelineSeq(seq);
      await harness.callAgentTool(
        "advisor_review",
        { focus: `Failure ${seq}.` },
        { threadId: "thread-primary" },
      );
    }
    const panel = (await harness.callRpc("threadReviews", {
      threadId: "thread-primary",
    })) as { incidents: unknown[] };
    expect(panel.incidents).toHaveLength(50);
  });
});

describe("machine-scoped model selection", () => {
  it("discovers each machine's live catalog and uses that machine's saved model", async () => {
    const { harness, spawn, setTimelineSeq } = await loadAdvisor(`ADVISOR_RESULT
severity: pass
summary: Looks correct
details:
none
END_ADVISOR_RESULT`);
    harness.sdk.stub("hosts.list", async () => [
      { id: "host-test", name: "Laptop", status: "connected" },
      { id: "host-remote", name: "Server", status: "disconnected" },
    ]);
    harness.sdk.stub("providers.list", async () => [
      {
        id: "codex",
        displayName: "Codex",
        available: true,
        capabilities: { supportedPermissionModes: ["readonly"] },
      },
    ]);
    harness.sdk.stub("providers.models", async () => ({
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          available: true,
          capabilities: { supportedPermissionModes: ["readonly"] },
        },
      ],
      models: [
        {
          model: "gpt-primary",
          displayName: "GPT Primary",
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
          ],
          defaultReasoningEffort: "medium",
        },
        {
          model: "gpt-advisor",
          displayName: "GPT Advisor",
          isDefault: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "high" },
            { reasoningEffort: "xhigh" },
          ],
          defaultReasoningEffort: "high",
        },
      ],
      modelLoadError: null,
    }));

    const configuration = await harness.callRpc("modelConfiguration", null);
    expect(configuration).toMatchObject({
      hosts: [
        {
          hostId: "host-test",
          hostName: "Laptop",
          connected: true,
          selection: null,
          options: [
            {
              providerId: "codex",
              model: "gpt-advisor",
              supportedReasoningLevels: ["high", "xhigh"],
              defaultReasoningLevel: "high",
            },
            {
              providerId: "codex",
              model: "gpt-primary",
              supportedReasoningLevels: ["low", "medium"],
              defaultReasoningLevel: "medium",
            },
          ],
        },
        {
          hostId: "host-remote",
          connected: false,
          options: [],
        },
      ],
    });

    await expect(
      harness.callRpc("setHostModel", {
        hostId: "host-test",
        selection: {
          providerId: "codex",
          model: "gpt-advisor",
          reasoningLevel: "ultracode",
        },
      }),
    ).rejects.toThrow("not available");

    await harness.callRpc("setHostModel", {
      hostId: "host-test",
      selection: {
        providerId: "codex",
        model: "gpt-advisor",
        reasoningLevel: "xhigh",
      },
    });
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Review the implementation." },
      { threadId: "thread-primary" },
    );

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "codex",
        model: "gpt-advisor",
        reasoningLevel: "xhigh",
        environment: { type: "reuse", environmentId: "environment-test" },
      }),
    );

    await harness.callRpc("setHostModel", {
      hostId: "host-test",
      selection: {
        providerId: "codex",
        model: "gpt-advisor",
        reasoningLevel: "high",
      },
    });
    setTimelineSeq(43);
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Review after changing reasoning." },
      { threadId: "thread-primary" },
    );

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerId: "codex",
        model: "gpt-advisor",
        reasoningLevel: "high",
      }),
    );
  });

  it("excludes incompatible providers and unverified fallback catalogs", async () => {
    const { harness } = await loadAdvisor(`ADVISOR_RESULT
severity: pass
summary: Looks correct
details:
none
END_ADVISOR_RESULT`);
    harness.sdk.stub("hosts.list", async () => [
      { id: "host-test", name: "Laptop", status: "connected" },
    ]);
    harness.sdk.stub("providers.list", async () => [
      {
        id: "codex",
        displayName: "Codex",
        available: true,
        capabilities: { supportedPermissionModes: ["readonly"] },
      },
      {
        id: "pi",
        displayName: "Pi",
        available: true,
        capabilities: { supportedPermissionModes: ["full"] },
      },
    ]);
    harness.sdk.stub("providers.models", async () => ({
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          available: true,
          capabilities: { supportedPermissionModes: ["readonly"] },
        },
      ],
      models: [
        {
          model: "fallback-model",
          displayName: "Fallback model",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          defaultReasoningEffort: "medium",
        },
      ],
      modelLoadError: { providerId: "codex", code: "timeout" },
    }));

    await expect(
      harness.callRpc("setHostModel", {
        hostId: "host-test",
        selection: {
          providerId: "pi",
          model: "pi-model",
          reasoningLevel: "default",
        },
      }),
    ).rejects.toThrow("not available");
    await expect(
      harness.callRpc("setHostModel", {
        hostId: "host-test",
        selection: {
          providerId: "codex",
          model: "fallback-model",
          reasoningLevel: "default",
        },
      }),
    ).rejects.toThrow("not available");
  });

  it("falls back to the primary model when a saved configuration becomes unavailable", async () => {
    const { harness, spawn } = await loadAdvisor(`ADVISOR_RESULT
severity: pass
summary: Looks correct
details:
none
END_ADVISOR_RESULT`);
    let catalogAvailable = true;
    harness.sdk.stub("providers.list", async () => [
      {
        id: "codex",
        displayName: "Codex",
        available: true,
        capabilities: { supportedPermissionModes: ["readonly"] },
      },
    ]);
    harness.sdk.stub("providers.models", async () => ({
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          available: true,
          capabilities: { supportedPermissionModes: ["readonly"] },
        },
      ],
      models: [
        {
          model: "gpt-advisor",
          displayName: "GPT Advisor",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          defaultReasoningEffort: "high",
        },
      ],
      modelLoadError: catalogAvailable
        ? null
        : { providerId: "codex", code: "timeout" },
    }));

    await harness.callRpc("setHostModel", {
      hostId: "host-test",
      selection: {
        providerId: "codex",
        model: "gpt-advisor",
        reasoningLevel: "high",
      },
    });
    catalogAvailable = false;
    await harness.callAgentTool(
      "advisor_review",
      { focus: "Review with a stale selection." },
      { threadId: "thread-primary" },
    );

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "codex", model: "gpt-5.6" }),
    );
    expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).not.toHaveProperty(
      "reasoningLevel",
    );
  });
});
