import type { Api, Model } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { formatCodexDashboard } from "./dashboard.ts";
import type { ContextStatus } from "./status.ts";
import type { FastStatus } from "./fast-status.ts";

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
const context: ContextStatus = {
  model,
  usage: { tokens: 40_000, contextWindow: 272_000, percent: 14.7 },
  standardWindow: 272_000,
  extendedWindow: 922_000,
  branch: [],
};
const inherited: FastStatus = {
  preference: "inherit",
  requestPolicy: "untouched",
  lastObserved: undefined,
  conflict: false,
};

it("puts fast and context state together, with discoverable configured commands", () => {
  const original = structuredClone({ context, inherited });
  const text = formatCodexDashboard(context, inherited, "personal:codex");
  expect(text).toContain("Codex · openai-codex/gpt-6-sol");
  expect(text).toContain("Fast: Provider default (no override)");
  expect(text).toContain("Context: 40k / 272k tokens (standard)");
  expect(text).toContain("/personal:codex usage — account allowance");
  expect(text).toContain(
    '/personal:codex context on|off|toggle — local context window (type "context o" for on/off suggestions)',
  );
  expect(text).toContain(
    '/personal:codex fast on|off|toggle — priority controls (type "fast o" for on/off suggestions)',
  );
  for (const removed of [
    "extend|restore",
    " fast status",
    " fast reset",
    " context status",
    " context reset",
  ]) {
    expect(text).not.toContain(removed);
  }
  expect(text).not.toContain("/eleith:codex");
  expect(text).not.toContain("Eligibility:");
  expect(text).not.toContain("Tab for options");
  expect({ context, inherited }).toEqual(original);
});

it("does not present requested priority as confirmed server processing", () => {
  const fast: FastStatus = {
    ...inherited,
    preference: "on",
    requestPolicy: "priority",
    lastObserved: "default",
  };
  const text = formatCodexDashboard(context, fast, "eleith:codex");
  expect(text).toContain("Fast: On (priority requested)\nLast reported tier: Standard");
  expect(text).not.toContain("Last reported tier: Priority");
  expect(text).toContain("Context: 40k / 272k tokens (standard)");
});

it("shows a saved on choice without needing an eligibility snapshot or a new response", () => {
  const fast: FastStatus = {
    ...inherited,
    preference: "on",
    requestPolicy: "priority",
  };
  const original = structuredClone(fast);
  const text = formatCodexDashboard(context, fast, "eleith:codex");
  expect(text).toContain("Fast: On (priority requested)\nNo response tier reported yet.");
  expect(text).toContain("Priority requests use more allowance.");
  expect(text).not.toContain("Paused");
  expect(text).not.toContain("Eligibility:");
  expect(fast).toEqual(original);
});

it("keeps the effective context window distinct from the selected model window", () => {
  const snapshot: ContextStatus = {
    ...context,
    model: { ...model, contextWindow: 922_000 },
  };
  const original = structuredClone(snapshot);
  const text = formatCodexDashboard(snapshot, inherited, "eleith:codex");
  expect(text).toContain(
    "Fast: Provider default (no override)\nContext: 40k / 272k tokens (effective) · Selected context window: 922k tokens (extended)",
  );
  expect(text).not.toContain("Context: 40k / 922k");
  expect(snapshot).toEqual(original);
});

it("keeps the context snapshot visible when fast state is unavailable", () => {
  const text = formatCodexDashboard(context, undefined, "eleith:codex");
  expect(text).toContain("Fast: unavailable\nContext: 40k / 272k tokens (standard)");
});

it("does not invent a model or context window when no model is selected", () => {
  expect(formatCodexDashboard(undefined, undefined, "eleith:codex")).toBe("No model selected.");
});
