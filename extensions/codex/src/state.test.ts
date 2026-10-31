import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CONTEXT_ENTRY, readPreferences } from "./state.ts";

function preference(
  data: unknown,
  id = "preference",
  parentId: string | null = null,
  customType = CONTEXT_ENTRY,
): Extract<SessionEntry, { type: "custom" }> {
  return { type: "custom", id, parentId, timestamp: "2026-01-01T00:00:00Z", customType, data };
}

const enabled = { provider: "openai-codex", modelId: "gpt-6-sol", extended: true };

describe("active branch preferences", () => {
  it("preserves literal branch entries written by context-window before the rename", () => {
    const legacyEntry = preference(enabled, "legacy", null, "eleith-context");
    expect(CONTEXT_ENTRY).toBe("eleith-context");
    expect(readPreferences([legacyEntry])).toEqual(new Map([["openai-codex/gpt-6-sol", true]]));
  });

  it("returns an empty map for an empty branch", () => {
    expect(readPreferences([])).toEqual(new Map());
  });

  it("keeps explicit true and false choices separately by provider/model", () => {
    const branch: SessionEntry[] = [
      preference(enabled),
      preference({ ...enabled, modelId: "gpt-6-astra", extended: false }),
      preference({ ...enabled, provider: "other", extended: false }),
    ];
    expect(readPreferences(branch)).toEqual(
      new Map([
        ["openai-codex/gpt-6-sol", true],
        ["openai-codex/gpt-6-astra", false],
        ["other/gpt-6-sol", false],
      ]),
    );
  });

  it.each([
    undefined,
    null,
    "extended",
    1,
    [],
    {},
    { modelId: "gpt-6-sol", extended: true },
    { provider: 1, modelId: "gpt-6-sol", extended: true },
    { provider: "openai-codex", extended: true },
    { provider: "openai-codex", modelId: null, extended: true },
    { provider: "openai-codex", modelId: "gpt-6-sol" },
    { ...enabled, extended: "true" },
    { ...enabled, extended: 1 },
    { provider: "openai-codex", model: "gpt-6-sol", contextWindow: 922_000 },
  ])("ignores malformed or legacy data: %j", (data) => {
    expect(readPreferences([preference(data)])).toEqual(new Map());
  });

  it("requires both custom entry type and the current customType", () => {
    const branch: SessionEntry[] = [
      preference(enabled, "unrelated", null, "another-extension"),
      preference(enabled, "old", null, "context"),
      {
        type: "custom_message",
        id: "message",
        parentId: null,
        timestamp: "2026-01-01T00:00:00Z",
        customType: CONTEXT_ENTRY,
        content: "Not a preference entry",
        details: enabled,
        display: false,
      },
    ];
    expect(readPreferences(branch)).toEqual(new Map());
  });

  it("uses the last valid choice in branch order, even with older timestamps", () => {
    const first = preference(enabled, "first");
    const second = preference({ ...enabled, extended: false }, "second", first.id);
    second.timestamp = "2025-01-01T00:00:00Z";
    const malformed = preference({ ...enabled, extended: "true" }, "bad", second.id);
    expect(readPreferences([first, second, malformed])).toEqual(
      new Map([["openai-codex/gpt-6-sol", false]]),
    );
    expect(readPreferences([first, second, preference(enabled, "third", second.id)])).toEqual(
      new Map([["openai-codex/gpt-6-sol", true]]),
    );
  });

  it("reads only the supplied branch and does not retain abandoned choices", () => {
    const shared = preference(enabled, "shared");
    const abandoned: SessionEntry[] = [
      shared,
      preference({ ...enabled, extended: false }, "abandoned", shared.id),
      preference({ ...enabled, modelId: "gpt-6-astra" }, "abandoned-model", "abandoned"),
    ];
    const active: SessionEntry[] = [
      shared,
      { type: "session_info", id: "active", parentId: shared.id, timestamp: shared.timestamp },
    ];
    expect(readPreferences(abandoned)).toEqual(
      new Map([
        ["openai-codex/gpt-6-sol", false],
        ["openai-codex/gpt-6-astra", true],
      ]),
    );
    expect(readPreferences(active)).toEqual(new Map([["openai-codex/gpt-6-sol", true]]));
    expect(readPreferences([])).toEqual(new Map());
  });
});
