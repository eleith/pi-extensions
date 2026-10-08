import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { formatContextStatus } from "./status.ts";

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
const status: Parameters<typeof formatContextStatus>[0] = {
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

describe("context status windows", () => {
  it("reports the selected model and local extended metadata without changing it", () => {
    const current = {
      ...status,
      extendedWindow: 922_000,
      usage: { tokens: 12_000, contextWindow: 922_000, percent: 1.3 },
    };
    const original = structuredClone(current);
    const report = formatContextStatus(current, NOW);
    expect(report).toContain("context-codex · openai-codex/gpt-6-sol");
    expect(report).toMatch(/^    Usage +12k \/ 922k$/m);
    expect(report).toMatch(/^    Standard +272k$/m);
    expect(report).toMatch(/^    Extended +922k \(local window\)$/m);
    expect(current).toEqual(original);
  });

  it("shows unknown usage with the model window when usage is unavailable", () => {
    const report = formatContextStatus(status, NOW);
    expect(report).toMatch(/^    Usage +unknown \/ 272k$/m);
    expect(report).toMatch(/^    Extended +not verified$/m);
  });

  it.each([null, -1, NaN, Infinity])("does not turn invalid token usage %s into zero", (tokens) => {
    const report = formatContextStatus(
      { ...status, usage: { tokens, contextWindow: 922_000, percent: null } },
      NOW,
    );
    expect(report).toMatch(/^    Usage +unknown \/ 922k$/m);
  });

  it("preserves genuinely zero context usage", () => {
    const report = formatContextStatus(
      { ...status, usage: { tokens: 0, contextWindow: 272_000, percent: 0 } },
      NOW,
    );
    expect(report).toMatch(/^    Usage +0 \/ 272k$/m);
  });
});

describe("catalog baseline and desired state", () => {
  it("reports unknown baseline honestly without inventing an extended target", () => {
    const report = formatContextStatus({ ...status, standardWindow: undefined }, NOW);
    expect(report).toMatch(/^    Standard +unknown$/m);
    expect(report).toContain("unknown; reselect a catalog model");
  });

  it("explains an already extended-sized catalog baseline", () => {
    const report = formatContextStatus(
      { ...status, standardWindow: 1_000_000, extendedWindow: 1_000_000 },
      NOW,
    );
    expect(report).toContain("catalog already provides this window; no extension needed");
  });

  it.each([true, false])(
    "keeps desired preference %s separate from effective usage and replay pause",
    (desiredExtended) => {
      const report = formatContextStatus({ ...status, desiredExtended, replayPaused: true }, NOW);
      expect(report).toContain(
        `${desiredExtended ? "extended" : "standard"} (desired, not a receipt)`,
      );
      expect(report).toMatch(/^    Usage +unknown \/ 272k$/m);
      expect(report).toContain("paused; explicitly extend or restore");
    },
  );
});

describe("context status compactions", () => {
  it("reports no compaction on an empty branch", () => {
    const report = formatContextStatus(status, NOW);
    expect(report).toMatch(/^    Compactions +0 on this branch$/m);
    expect(report).toMatch(/^    Last compacted +never on this branch$/m);
  });

  it("counts only supplied branch compactions and uses the last in branch order", () => {
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
    expect(formatContextStatus({ ...status, branch: [shared, abandoned] }, NOW)).toMatch(
      /^    Last compacted +1 hour ago$/m,
    );
    const report = formatContextStatus({ ...status, branch: [shared, active, summary] }, NOW);
    expect(report).toMatch(/^    Compactions +2 on this branch$/m);
    expect(report).toMatch(/^    Last compacted +2 days ago$/m);
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
  ])("formats elapsed time at %d ms", (age, expected) => {
    const branch = [compaction("compact", new Date(NOW - age).toISOString())];
    expect(formatContextStatus({ ...status, branch }, NOW)).toMatch(
      new RegExp(`^    Last compacted +${expected}$`, "m"),
    );
  });

  it.each(["not-a-date", new Date(NOW + 1000).toISOString()])(
    "reports unknown elapsed time for %s",
    (timestamp) => {
      const report = formatContextStatus(
        { ...status, branch: [compaction("compact", timestamp)] },
        NOW,
      );
      expect(report).toMatch(/^    Compactions +1 on this branch$/m);
      expect(report).toMatch(/^    Last compacted +unknown$/m);
    },
  );
});

describe("context status cache reports", () => {
  it("does not invent cache metrics without an assistant request", () => {
    const branch = [message({ role: "user", content: "Hello", timestamp: NOW })];
    const report = formatContextStatus({ ...status, branch }, NOW);
    expect(report).toMatch(/^    Cached input +not reported$/m);
    expect(report).not.toMatch(/^    Cache writes /m);
  });

  it("adds disjoint uncached, cache-read and cache-write counts, excluding output", () => {
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
    const report = formatContextStatus({ ...status, branch }, NOW);
    expect(report).toMatch(/^    Cached input +6k \/ 9k input tokens$/m);
    expect(report).toMatch(/^    Cache writes +1k tokens$/m);
    expect(report).not.toMatch(/^    Model /m);
  });

  it("allows cache reads to account for all input", () => {
    const branch = [message(assistant({ cacheRead: 1000 }))];
    expect(formatContextStatus({ ...status, branch }, NOW)).toMatch(
      /^    Cached input +1k \/ 1k input tokens$/m,
    );
  });

  it.each([0, 1000])("calls zero cache reads none reported with %d cache writes", (cacheWrite) => {
    const branch = [message(assistant({ input: 2000, cacheWrite }))];
    const report = formatContextStatus({ ...status, branch }, NOW);
    expect(report).toMatch(
      new RegExp(
        `^    Cached input +none reported \\(${cacheWrite ? "3k" : "2k"} input tokens\\)$`,
        "m",
      ),
    );
    if (cacheWrite) expect(report).toMatch(/^    Cache writes +1k tokens$/m);
    else expect(report).not.toMatch(/^    Cache writes /m);
  });

  it("treats an all-zero failed request as unreported rather than a cache miss", () => {
    const branch = [
      message(assistant({}, { stopReason: "error", errorMessage: "Request failed" })),
    ];
    const report = formatContextStatus({ ...status, branch }, NOW);
    expect(report).toMatch(/^    Cached input +not reported$/m);
    expect(report).not.toContain("none reported");
  });

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
    const report = formatContextStatus({ ...status, branch }, NOW);
    expect(report).toMatch(/^    Cached input +not reported$/m);
    expect(report).not.toMatch(/^    Cache writes /m);
  });

  it.each([undefined, { input: 2000, cacheWrite: 0 }])(
    "tolerates missing persisted usage or counters: %j",
    (usage) => {
      // Persisted legacy/malformed messages can lack fields required by today's type.
      const persisted = { ...assistant(), usage } as unknown as AssistantMessage;
      const report = formatContextStatus({ ...status, branch: [message(persisted)] }, NOW);
      expect(report).toMatch(/^    Cached input +not reported$/m);
    },
  );

  it("uses the last assistant even after a model switch and trailing non-assistant entries", () => {
    const branch: SessionEntry[] = [
      message(assistant({ input: 1000, cacheRead: 9000 }), "earlier"),
      message(
        assistant({ input: 2000, cacheRead: 1000 }, { provider: "other", model: "prior-model" }),
        "last",
      ),
      {
        type: "model_change",
        id: "switch",
        parentId: "last",
        timestamp: new Date(NOW).toISOString(),
        provider: model.provider,
        modelId: model.id,
      },
      message({ role: "user", content: "Next request", timestamp: NOW }, "user"),
      compaction("compact", new Date(NOW).toISOString()),
    ];
    const report = formatContextStatus({ ...status, branch }, NOW);
    expect(report).toMatch(/^    Model +other\/prior-model$/m);
    expect(report).toMatch(/^    Cached input +1k \/ 3k input tokens$/m);
    expect(report).not.toContain("9k / 10k");
  });

  it("still identifies the prior request model when its usage was not reported", () => {
    const branch = [message(assistant({}, { provider: "other", model: "prior-model" }))];
    const report = formatContextStatus({ ...status, branch }, NOW);
    expect(report).toMatch(/^    Model +other\/prior-model$/m);
    expect(report).toMatch(/^    Cached input +not reported$/m);
  });
});
