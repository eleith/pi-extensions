import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { type ContextStatus, formatContextSummary } from "./status.ts";

const NOW = Date.parse("2026-01-10T12:00:00Z");
const model: Model<Api> = {
  id: "gpt-6-sol",
  provider: "openai-codex",
  name: "Sol",
  api: "openai-codex-responses",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
};
const status: ContextStatus = {
  model,
  usage: undefined,
  standardWindow: 272_000,
  extendedWindow: undefined,
  branch: [],
};

function assistant(
  usage: Partial<AssistantMessage["usage"]> = {},
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...usage,
    },
    stopReason: "stop",
    timestamp: NOW,
    ...overrides,
  };
}

function message(
  value: Extract<SessionEntry, { type: "message" }>["message"],
  id = "message",
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(NOW).toISOString(),
    message: value,
  };
}

function compaction(id: string, timestamp: string, parentId: string | null = null): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp,
    summary: "Compacted",
    firstKeptEntryId: "kept",
    tokensBefore: 100_000,
  };
}

describe("context summary occupancy", () => {
  it("uses the physical 128k window for a routed model advertising an extended 1m window", () => {
    const report = formatContextSummary(
      {
        ...status,
        model: { ...model, contextWindow: 1_000_000 },
        extendedWindow: 1_000_000,
        desiredExtended: true,
        usage: { tokens: 120_000, contextWindow: 128_000, percent: 93.75 },
      },
      NOW,
    );
    expect(report.split("\n")[0]).toBe(
      "Context: 120k / 128k tokens (effective) · Selected context window: 1m tokens (extended)",
    );
    expect(report).not.toContain("pending");
  });

  it.each([undefined, 0])(
    "keeps known effective occupancy when the selected window is %s",
    (contextWindow) => {
      // A routed or persisted model may lack today's required window metadata.
      const selected = { ...model, contextWindow } as unknown as Model<Api>;
      const report = formatContextSummary(
        {
          ...status,
          model: selected,
          usage: { tokens: 120_000, contextWindow: 128_000, percent: 93.75 },
        },
        NOW,
      );
      expect(report.split("\n")[0]).toBe(
        "Context: 120k / 128k tokens (effective) · Selected context window: unknown tokens (window unknown)",
      );
    },
  );

  it("provides three read-only local lines without a model header or fast hint", () => {
    const current: ContextStatus = {
      ...status,
      usage: { tokens: 40_000, contextWindow: 272_000, percent: 14.7 },
      branch: [
        compaction("first", "2026-01-10T11:50:00Z"),
        compaction("last", "2026-01-10T11:55:00Z", "first"),
        message(assistant({ input: 10_000, cacheRead: 20_000 })),
      ],
    };
    const original = structuredClone(current);
    expect(formatContextSummary(current, NOW)).toBe(
      "Context: 40k / 272k tokens (standard)\n" +
        "Compaction: 2 on this branch · last 5 minutes ago\n" +
        "Cached input: 20k / 30k (last assistant request)",
    );
    expect(current).toEqual(original);
  });

  it.each([
    [272_000, "standard"],
    [922_000, "extended"],
    [500_000, "custom"],
  ] as const)("keeps the selected %d window's %s label separate", (contextWindow, label) => {
    const report = formatContextSummary(
      {
        ...status,
        model: { ...model, contextWindow },
        extendedWindow: 922_000,
        usage: { tokens: 12_000, contextWindow: 128_000, percent: 9.375 },
      },
      NOW,
    );
    expect(report.split("\n")[0]).toBe(
      `Context: 12k / 128k tokens (effective) · Selected context window: ${contextWindow / 1000}k tokens (${label})`,
    );
  });

  it.each([undefined, null, 0, -1, NaN, Infinity])(
    "falls back to the selected window when the effective window is %s",
    (contextWindow) => {
      const usage = { tokens: 12_000, contextWindow, percent: null } as unknown as ContextUsage;
      expect(formatContextSummary({ ...status, usage }, NOW).split("\n")[0]).toBe(
        "Context: 12k / 272k tokens (standard)",
      );
    },
  );

  it.each([null, -1, NaN, Infinity])("keeps invalid token usage %s unknown", (tokens) => {
    const report = formatContextSummary(
      { ...status, usage: { tokens, contextWindow: 272_000, percent: null } },
      NOW,
    );
    expect(report.split("\n")[0]).toBe("Context: 272k tokens (standard) · usage not reported");
  });

  it("retains the effective window even when token usage is unknown", () => {
    const report = formatContextSummary(
      { ...status, usage: { tokens: null, contextWindow: 128_000, percent: null } },
      NOW,
    );
    expect(report.split("\n")[0]).toBe(
      "Context: 128k tokens (effective) · usage not reported · Selected context window: 272k tokens (standard)",
    );
  });

  it("does not fabricate a zero window when neither window is known", () => {
    const report = formatContextSummary(
      {
        ...status,
        model: { ...model, contextWindow: 0 },
        usage: { tokens: 12_000, contextWindow: 0, percent: null },
      },
      NOW,
    );
    expect(report.split("\n")[0]).toBe("Context: 12k / unknown tokens (window unknown)");
  });

  it("preserves measured zero usage and keeps an empty branch compact", () => {
    expect(
      formatContextSummary(
        { ...status, usage: { tokens: 0, contextWindow: 272_000, percent: 0 } },
        NOW,
      ),
    ).toBe(
      "Context: 0 / 272k tokens (standard)\n" +
        "Compaction: 0 on this branch\n" +
        "Cached input: not reported",
    );
  });
});

describe("context summary baselines and desired state", () => {
  it("does not infer a baseline from the model name or a verified extended window", () => {
    const report = formatContextSummary(
      {
        ...status,
        model: { ...model, contextWindow: 922_000 },
        standardWindow: undefined,
        extendedWindow: 922_000,
      },
      NOW,
    );
    expect(report.split("\n")[0]).toBe(
      "Context: 922k tokens (baseline unknown) · usage not reported",
    );
  });

  it("labels a catalog already at the extended target standard with no pending replay", () => {
    const report = formatContextSummary(
      {
        ...status,
        model: { ...model, contextWindow: 1_000_000 },
        standardWindow: 1_000_000,
        extendedWindow: 1_000_000,
        desiredExtended: true,
      },
      NOW,
    );
    expect(report.split("\n")[0]).toBe("Context: 1m tokens (standard) · usage not reported");
  });

  it("does not call a larger custom window extended without verified metadata", () => {
    const report = formatContextSummary(
      { ...status, model: { ...model, contextWindow: 922_000 } },
      NOW,
    );
    expect(report.split("\n")[0]).toBe("Context: 922k tokens (custom) · usage not reported");
  });

  it.each([
    [true, 272_000, "standard", "extended"],
    [false, 922_000, "extended", "standard"],
  ] as const)(
    "does not present desired extended=%s as active",
    (desiredExtended, contextWindow, active, desired) => {
      const current = {
        ...status,
        model: { ...model, contextWindow },
        extendedWindow: 922_000,
        desiredExtended,
      };
      expect(formatContextSummary(current, NOW).split("\n")[0]).toBe(
        `Context: ${contextWindow / 1000}k tokens (${active}) · usage not reported · ${desired} pending normal prompt`,
      );
      const paused = formatContextSummary({ ...current, replayPaused: true }, NOW);
      expect(paused.split("\n")[0]).toBe(
        `Context: ${contextWindow / 1000}k tokens (${active}) · usage not reported · ${desired} pending · replay paused`,
      );
      expect(paused).not.toContain("normal prompt");
    },
  );

  it("keeps pending replay tied to the selected window, not a matching physical window", () => {
    const current: ContextStatus = {
      ...status,
      model: { ...model, contextWindow: 922_000 },
      desiredExtended: false,
      usage: { tokens: 120_000, contextWindow: 128_000, percent: 93.75 },
      standardWindow: 128_000,
      extendedWindow: 922_000,
    };
    expect(formatContextSummary(current, NOW).split("\n")[0]).toBe(
      "Context: 120k / 128k tokens (effective) · Selected context window: 922k tokens (extended) · standard pending normal prompt",
    );
    expect(formatContextSummary({ ...current, replayPaused: true }, NOW).split("\n")[0]).toBe(
      "Context: 120k / 128k tokens (effective) · Selected context window: 922k tokens (extended) · standard pending · replay paused",
    );
  });

  it.each([
    [false, 272_000, "standard"],
    [true, 922_000, "extended"],
  ] as const)(
    "omits pending when desired extended=%s matches the selected window",
    (desiredExtended, contextWindow, label) => {
      const report = formatContextSummary(
        {
          ...status,
          model: { ...model, contextWindow },
          extendedWindow: 922_000,
          desiredExtended,
        },
        NOW,
      );
      expect(report.split("\n")[0]).toBe(
        `Context: ${contextWindow / 1000}k tokens (${label}) · usage not reported`,
      );
    },
  );

  it.each([true, false])(
    "does not promise replay with an unknown target (%s)",
    (desiredExtended) => {
      const report = formatContextSummary(
        { ...status, standardWindow: undefined, desiredExtended, replayPaused: true },
        NOW,
      );
      expect(report.split("\n")[0]).toBe(
        "Context: 272k tokens (baseline unknown) · usage not reported · " +
          `${desiredExtended ? "extended" : "standard"} desired (target unknown) · replay paused`,
      );
      expect(report).not.toContain("normal prompt");
    },
  );

  it("retains the replay pause even without a saved preference", () => {
    expect(formatContextSummary({ ...status, replayPaused: true }, NOW).split("\n")[0]).toBe(
      "Context: 272k tokens (standard) · usage not reported · replay paused",
    );
  });
});

describe("context summary branch compactions", () => {
  it("counts only the supplied active branch and uses branch order rather than timestamps", () => {
    const shared = compaction("shared", "2026-01-10T11:59:59Z");
    const abandoned = compaction("abandoned", "2026-01-10T11:00:00Z", "shared");
    const active = compaction("active", "2026-01-08T12:00:00Z", "shared");
    const summary: SessionEntry = {
      type: "branch_summary",
      id: "summary",
      parentId: "active",
      timestamp: "2026-01-10T12:00:00Z",
      fromId: "abandoned",
      summary: "Branch summary",
    };
    expect(
      formatContextSummary({ ...status, branch: [shared, abandoned] }, NOW).split("\n")[1],
    ).toBe("Compaction: 2 on this branch · last 1 hour ago");
    expect(
      formatContextSummary({ ...status, branch: [shared, active, summary] }, NOW).split("\n")[1],
    ).toBe("Compaction: 2 on this branch · last 2 days ago");
  });

  it.each([
    [0, "just now"],
    [59_999, "just now"],
    [60_000, "1 minute ago"],
    [120_000, "2 minutes ago"],
    [3_599_999, "59 minutes ago"],
    [3_600_000, "1 hour ago"],
    [7_200_000, "2 hours ago"],
    [86_399_999, "23 hours ago"],
    [86_400_000, "1 day ago"],
    [172_800_000, "2 days ago"],
  ])("reports the final branch compaction's age at %d ms", (age, expected) => {
    const branch = [compaction("last", new Date(NOW - age).toISOString())];
    expect(formatContextSummary({ ...status, branch }, NOW).split("\n")[1]).toBe(
      `Compaction: 1 on this branch · last ${expected}`,
    );
  });

  it.each(["not-a-date", new Date(NOW + 1000).toISOString()])(
    "does not invent the last compaction time for %s",
    (timestamp) => {
      const branch = [compaction("last", timestamp)];
      expect(formatContextSummary({ ...status, branch }, NOW).split("\n")[1]).toBe(
        "Compaction: 1 on this branch · last time unknown",
      );
    },
  );
});

describe("context summary last-request cache", () => {
  it("does not invent cache metrics without an assistant request", () => {
    const branch = [message({ role: "user", content: "Hello", timestamp: NOW })];
    expect(formatContextSummary({ ...status, branch }, NOW).split("\n")[2]).toBe(
      "Cached input: not reported",
    );
  });

  it("includes disjoint cache writes in the input total but excludes output", () => {
    const branch = [
      message(
        assistant({
          input: 2000,
          cacheRead: 6000,
          cacheWrite: 1000,
          output: 4000,
          totalTokens: 13_000,
        }),
      ),
    ];
    const report = formatContextSummary({ ...status, branch }, NOW);
    expect(report.split("\n")).toHaveLength(3);
    expect(report.split("\n")[2]).toBe("Cached input: 6k / 9k · wrote 1k (last assistant request)");
  });

  it("allows cache reads to account for all input", () => {
    const branch = [message(assistant({ cacheRead: 1000 }))];
    expect(formatContextSummary({ ...status, branch }, NOW).split("\n")[2]).toBe(
      "Cached input: 1k / 1k (last assistant request)",
    );
  });

  it.each([
    { cacheWrite: 0, expected: "none reported · 2k input tokens" },
    { cacheWrite: 1000, expected: "none reported · 3k input tokens · wrote 1k" },
  ])(
    "does not call zero cache reads a measured miss with $cacheWrite writes",
    ({ cacheWrite, expected }) => {
      const branch = [message(assistant({ input: 2000, cacheWrite }))];
      expect(formatContextSummary({ ...status, branch }, NOW).split("\n")[2]).toBe(
        `Cached input: ${expected} (last assistant request)`,
      );
    },
  );

  it.each(["stop", "error"] as const)(
    "keeps an all-zero %s request unreported rather than claiming a cache miss",
    (stopReason) => {
      const branch = [message(assistant({}, { stopReason }))];
      expect(formatContextSummary({ ...status, branch }, NOW).split("\n")[2]).toBe(
        "Cached input: not reported (last assistant request)",
      );
    },
  );

  it.each([
    { input: -1 },
    { input: NaN },
    { cacheRead: -1 },
    { cacheRead: Infinity },
    { cacheWrite: -1 },
    { cacheWrite: NaN },
    { input: Number.MAX_VALUE, cacheRead: Number.MAX_VALUE },
  ])("rejects invalid or overflowing cache counts: %j", (usage) => {
    const branch = [
      message(assistant({ input: 2000, cacheRead: 6000, cacheWrite: 1000, ...usage })),
    ];
    expect(formatContextSummary({ ...status, branch }, NOW).split("\n")[2]).toBe(
      "Cached input: not reported (last assistant request)",
    );
  });

  it.each([undefined, { input: 2000, cacheWrite: 0 }])(
    "tolerates missing persisted usage or counters: %j",
    (usage) => {
      // Legacy/malformed messages can lack fields required by today's type.
      const persisted = { ...assistant(), usage } as unknown as AssistantMessage;
      expect(
        formatContextSummary({ ...status, branch: [message(persisted)] }, NOW).split("\n")[2],
      ).toBe("Cached input: not reported (last assistant request)");
    },
  );

  it.each([
    {
      scenario: "reported usage",
      usage: { input: 2000, cacheRead: 1000 },
      stopReason: "stop",
      expected: "1k / 3k",
    },
    {
      scenario: "a failed placeholder",
      usage: {},
      stopReason: "error",
      expected: "not reported",
    },
  ] as const)(
    "scopes the latest request's $scenario to its prior model after a switch",
    ({ usage, stopReason, expected }) => {
      const branch: SessionEntry[] = [
        message(assistant({ input: 1000, cacheRead: 9000 }), "earlier"),
        message(
          assistant(usage, { provider: "other", model: "prior-model", stopReason }),
          "latest",
        ),
        {
          type: "model_change",
          id: "switch",
          parentId: "latest",
          timestamp: new Date(NOW).toISOString(),
          provider: model.provider,
          modelId: model.id,
        },
        message({ role: "user", content: "Next request", timestamp: NOW }, "user"),
        compaction("last", new Date(NOW).toISOString()),
      ];
      const report = formatContextSummary({ ...status, branch }, NOW);
      expect(report.split("\n")[2]).toBe(
        `Cached input: ${expected} (last assistant request · other/prior-model)`,
      );
      expect(report).not.toContain("9k / 10k");
      expect(report).not.toContain("none reported");
    },
  );
});
