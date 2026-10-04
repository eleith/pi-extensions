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
    ["gpt-6-sol", "https://developers.openai.com/api/docs/models/gpt-6-sol"],
    ["gpt-6.1-sol", "https://developers.openai.com/api/docs/models/gpt-6-sol"],
    ["gpt-6-astra", "https://developers.openai.com/api/docs/models/gpt-6-astra"],
  ])("provides the 922000-token local window for %s", (id, source) => {
    const current = model(id);
    const original = structuredClone(current);
    expect(contextProfile(current)).toEqual({ extendedWindow: 922_000, source });
    // The profile is metadata, not a mutation of the model's server/output limits.
    expect(current).toEqual(original);
    expect(current.contextWindow).toBe(272_000);
    expect(current.maxTokens).toBe(128_000);
  });

  it.each([
    ["gpt-6-sol", "openai"],
    ["gpt-6-sol", "other"],
    ["gpt-6", "openai-codex"],
    ["GPT-6-SOL", "openai-codex"],
  ])("has no profile for %s at %s", (id, provider) => {
    expect(contextProfile(model(id, provider))).toBeUndefined();
  });

  it("has no profile without a selected model", () => {
    expect(contextProfile(undefined)).toBeUndefined();
  });
});
