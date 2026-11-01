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
  eligibility: "unknown",
  requestPolicy: "untouched",
  lastRequested: undefined,
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
    '/personal:codex fast — priority controls (type "fast o" for on/off suggestions)',
  );
  expect(text).not.toContain("/eleith:codex");
  expect(text).not.toContain("Eligibility:");
  expect(text).not.toContain("Tab for options");
  expect({ context, inherited }).toEqual(original);
});

it("does not present requested priority as confirmed server processing", () => {
  const fast: FastStatus = {
    ...inherited,
    preference: "on",
    eligibility: "supported",
    requestPolicy: "priority",
    lastRequested: "priority",
    lastObserved: "default",
  };
  const text = formatCodexDashboard(context, fast, "eleith:codex");
  expect(text).toContain("Fast: On (priority requested)\nLast reported tier: Standard");
  expect(text).not.toContain("Last reported tier: Priority");
  expect(text).toContain("Context: 40k / 272k tokens (standard)");
});

it("does not invent a model or context window when no model is selected", () => {
  expect(formatCodexDashboard(undefined, undefined, "eleith:codex")).toBe("No model selected.");
});
