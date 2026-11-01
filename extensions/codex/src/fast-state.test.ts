import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FAST_ENTRY, readFastPreferences, type FastChoice } from "./fast-state.ts";
import { CONTEXT_ENTRY, readPreferences } from "./state.ts";

function preference(
  data: unknown,
  id = "preference",
  parentId: string | null = null,
  customType = FAST_ENTRY,
): Extract<SessionEntry, { type: "custom" }> {
  return { type: "custom", id, parentId, timestamp: "2026-01-01T00:00:00Z", customType, data };
}

const enabled: FastChoice = { provider: "openai-codex", modelId: "gpt-6-sol", mode: "on" };

describe("active branch fast preferences", () => {
  it("uses a dedicated transcript identifier and returns an empty map for an empty branch", () => {
    expect(FAST_ENTRY).toBe("eleith-codex-fast");
    expect(readFastPreferences([])).toEqual(new Map());
  });

  it("keeps choices independent by provider and model", () => {
    const branch: readonly SessionEntry[] = [
      preference(enabled),
      preference({ ...enabled, modelId: "gpt-6-astra", mode: "off" }),
      preference({ ...enabled, provider: "other", mode: "inherit" }),
    ];
    expect(readFastPreferences(branch)).toEqual(
      new Map([
        ["openai-codex/gpt-6-sol", "on"],
        ["openai-codex/gpt-6-astra", "off"],
        ["other/gpt-6-sol", "inherit"],
      ]),
    );
  });

  it.each([
    undefined,
    null,
    "on",
    1,
    true,
    [],
    Object.assign([], enabled),
    {},
    { modelId: "gpt-6-sol", mode: "on" },
    { ...enabled, provider: 1 },
    { ...enabled, provider: "" },
    { provider: "openai-codex", mode: "on" },
    { ...enabled, modelId: null },
    { ...enabled, modelId: "" },
    { provider: "openai-codex", modelId: "gpt-6-sol" },
    { ...enabled, mode: true },
    { ...enabled, mode: "fast" },
    { ...enabled, mode: "ON" },
    { ...enabled, mode: null },
    { provider: "openai-codex", modelId: "gpt-6-sol", extended: true },
  ])("ignores malformed data: %j", (data) => {
    expect(readFastPreferences([preference(data)])).toEqual(new Map());
  });

  it("requires a custom entry with the fast customType", () => {
    expect(
      readFastPreferences([
        preference(enabled, "unrelated", null, "another-extension"),
        { type: "custom_message", customType: FAST_ENTRY, data: enabled },
        { type: "custom", data: enabled },
      ]),
    ).toEqual(new Map());
  });

  it("uses the latest valid entry in branch order, not timestamp order", () => {
    const first = preference(enabled, "first");
    const second = preference({ ...enabled, mode: "off" }, "second", first.id);
    second.timestamp = "2025-01-01T00:00:00Z";
    const malformed = preference({ ...enabled, mode: "invalid" }, "bad", second.id);
    expect(readFastPreferences([first, second, malformed])).toEqual(
      new Map([["openai-codex/gpt-6-sol", "off"]]),
    );
    expect(readFastPreferences([first, second, preference(enabled, "third", second.id)])).toEqual(
      new Map([["openai-codex/gpt-6-sol", "on"]]),
    );
  });

  it("preserves inherit as a tombstone until a later valid choice replaces it", () => {
    const branch = [preference(enabled), preference({ ...enabled, mode: "inherit" })];
    const preferences = readFastPreferences(branch);
    expect(preferences.has("openai-codex/gpt-6-sol")).toBe(true);
    expect(preferences.get("openai-codex/gpt-6-sol")).toBe("inherit");
    expect(readFastPreferences([...branch, preference({ ...enabled, mode: "off" })])).toEqual(
      new Map([["openai-codex/gpt-6-sol", "off"]]),
    );
  });

  it("reads only the supplied branch without retaining abandoned choices", () => {
    const shared = preference(enabled, "shared");
    const abandoned: SessionEntry[] = [
      shared,
      preference({ ...enabled, mode: "inherit" }, "abandoned", shared.id),
      preference({ ...enabled, modelId: "gpt-6-astra" }, "abandoned-model", "abandoned"),
    ];
    const active: readonly SessionEntry[] = [
      shared,
      { type: "session_info", id: "active", parentId: shared.id, timestamp: shared.timestamp },
    ];
    expect(readFastPreferences(abandoned)).toEqual(
      new Map([
        ["openai-codex/gpt-6-sol", "inherit"],
        ["openai-codex/gpt-6-astra", "on"],
      ]),
    );
    expect(readFastPreferences(active)).toEqual(new Map([["openai-codex/gpt-6-sol", "on"]]));
    expect(readFastPreferences([])).toEqual(new Map());
  });

  it("keeps fast and context schemas independent even when payload fields overlap", () => {
    const context = { provider: enabled.provider, modelId: enabled.modelId, extended: false };
    const branch = [
      preference({ ...enabled, extended: true }),
      preference({ ...context, mode: "off" }, "context", null, CONTEXT_ENTRY),
      preference(context, "wrong-fast-schema"),
      preference(enabled, "wrong-context-schema", null, CONTEXT_ENTRY),
    ];
    expect(readFastPreferences(branch)).toEqual(new Map([["openai-codex/gpt-6-sol", "on"]]));
    expect(readPreferences(branch)).toEqual(new Map([["openai-codex/gpt-6-sol", false]]));
  });
});
