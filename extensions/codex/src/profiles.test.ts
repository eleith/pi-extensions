import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { contextProfile, modelKey } from "./profiles.ts";

function model(id: string, provider = "openai-codex"): Model<Api> {
  return {
    id,
    provider,
    name: id,
    api: "openai-codex-responses",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  };
}

describe("context profiles", () => {
  it("keys models by provider and id, not display name", () => {
    const current = model("gpt-6-sol");
    current.name = "A display name";
    expect(modelKey(current)).toBe("openai-codex/gpt-6-sol");
    expect(modelKey({ provider: "other", id: current.id })).toBe("other/gpt-6-sol");
  });

  it.each([
    ["gpt-6-sol", 272_000],
    ["gpt-6.1-sol", 500_000],
    ["gpt-6-astra", 272_000],
    ["gpt-6.2-sol", 500_000],
    ["gpt-6.2-astra", 272_000],
  ] as const)("uses the Codex catalog maximum for %s", (id, contextWindow) => {
    const current = { ...model(id), contextWindow };
    const original = structuredClone(current);
    const profile = contextProfile(current);
    expect(profile).toEqual({
      extendedWindow: 872_000,
      source:
        "https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/models-manager/models.json",
    });
    expect(profile).toBe(contextProfile(model("gpt-6-sol")));
    expect(Object.isFrozen(profile)).toBe(true);
    expect(current).toEqual(original);
  });

  it.each([
    ["gpt-6-sol", "openai"],
    ["gpt-6-sol", "other"],
    ["gpt-6", "openai-codex"],
    ["gpt-6.2-sol", "openai"],
    ["gpt-6.1-astra", "openai-codex"],
    ["gpt-6.3-sol", "openai-codex"],
    ["gpt-7-sol", "openai-codex"],
    ["gpt-6-sol-2026-10-08", "openai-codex"],
    ["GPT-6-SOL", "openai-codex"],
  ])("has no profile for %s at %s", (id, provider) => {
    expect(contextProfile(model(id, provider))).toBeUndefined();
  });

  it("requires the native Codex API even when the provider and ID match", () => {
    expect(contextProfile({ ...model("gpt-6-sol"), api: "openai-responses" })).toBeUndefined();
  });

  it("has no profile without a selected model", () => {
    expect(contextProfile(undefined)).toBeUndefined();
  });
});
