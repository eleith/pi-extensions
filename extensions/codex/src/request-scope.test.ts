import type { Api, Model } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { expect, it, vi } from "vitest";
import { matchesDirectCodexSelection, type DirectCodexHost } from "./request-scope.ts";

const model: Model<Api> = {
  id: "gpt-6-sol",
  name: "Sol",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
};

type Registry = DirectCodexHost["modelRegistry"];

function fixture() {
  const registry = {
    getProvider: vi.fn<Registry["getProvider"]>(() => ({ baseUrl: model.baseUrl })),
    isUsingOAuth: vi.fn<Registry["isUsingOAuth"]>(() => true),
    getRegisteredProviderConfig: vi.fn<Registry["getRegisteredProviderConfig"]>(() => undefined),
    getRegisteredNativeProvider: vi.fn<Registry["getRegisteredNativeProvider"]>(() => undefined),
  };
  return { model, modelRegistry: registry };
}

it("matches a direct selection without modifying the payload or taking ownership of an existing tier", () => {
  const payload = Object.freeze({ model: model.id, service_tier: "flex", input: [] });
  expect(matchesDirectCodexSelection(payload, fixture())).toBe(true);
  expect(payload).toEqual({ model: model.id, service_tier: "flex", input: [] });
});

it.each([
  undefined,
  { ...model, provider: "openai" },
  { ...model, api: "pi-virtual" },
  { ...model, baseUrl: "https://gateway.invalid" },
])("rejects unsupported selections: %j", (selected) => {
  expect(matchesDirectCodexSelection({ model: model.id }, { ...fixture(), model: selected })).toBe(
    false,
  );
});

it.each([null, [], {}, { model: "different-model" }, { model: 42 }])(
  "requires an object payload naming the selected model: %j",
  (payload) => {
    expect(matchesDirectCodexSelection(payload, fixture())).toBe(false);
  },
);

it("rejects an effective endpoint override even if the selected model still looks official", () => {
  const host = fixture();
  host.modelRegistry.getProvider.mockReturnValue({ baseUrl: "https://gateway.invalid" });
  expect(matchesDirectCodexSelection({ model: model.id }, host)).toBe(false);
});

it("excludes registered provider overlays", () => {
  const host = fixture();
  host.modelRegistry.getRegisteredProviderConfig.mockReturnValue({
    headers: { "X-Example": "overlay" },
  });
  expect(matchesDirectCodexSelection({ model: model.id }, host)).toBe(false);
});

it("excludes registered native replacements, including a re-registered stock provider", () => {
  const host = fixture();
  host.modelRegistry.getRegisteredNativeProvider.mockReturnValue(openaiCodexProvider());
  expect(matchesDirectCodexSelection({ model: model.id }, host)).toBe(false);
});

it("does not match a selection whose auth snapshot is not OAuth", () => {
  const host = fixture();
  host.modelRegistry.isUsingOAuth.mockReturnValue(false);
  expect(matchesDirectCodexSelection({ model: model.id }, host)).toBe(false);
});
