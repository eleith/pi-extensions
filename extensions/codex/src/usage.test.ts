import { expect, it } from "vitest";
import { formatCodexUsage } from "./usage.ts";

const NOW = Date.parse("2026-01-10T12:00:00Z");
const primary = {
  used_percent: 25,
  limit_window_seconds: 1800,
  reset_at: NOW / 1000 + 3600,
};

it("formats an exact account report without mutating the payload", () => {
  const payload = {
    plan_type: "plus",
    account_id: "do-not-display-account-id",
    rate_limit: { allowed: true, primary_window: primary, secondary_window: null },
    credits: { has_credits: true, unlimited: false, balance: "12.50" },
    future_field: { anything: true },
  };
  const original = structuredClone(payload);
  const report = formatCodexUsage(payload, NOW)!;
  expect(report).toBe(`codex account usage · openai-codex
Plan: plus

Codex
  Primary (30m): 25% used · 75% remaining
    Resets: 2026-01-10 13:00:00 UTC (in 1h)
  Secondary: not reported

Credits: 12.5 balance (available)`);
  expect(payload).toEqual(original);
});

it("does not invent windows or unlimited credits for plans with missing quota data", () => {
  const report = formatCodexUsage(
    {
      plan_type: "pro",
      rate_limit: null,
      code_review_rate_limit: null,
      credits: null,
    },
    NOW,
  )!;
  expect(report).toContain("Codex\n  Not reported");
  expect(report).toContain("Code review\n  Not reported");
  expect(report).toContain("Credits: not reported");
  expect(report).not.toMatch(/0%|5h|7d|unlimited/);
});

it.each([
  [0, "0% used · 100% remaining"],
  [-1, "usage unknown"],
  [101, "usage unknown"],
  [NaN, "usage unknown"],
  ["25", "usage unknown"],
] as const)("keeps invalid percentages distinct from genuine zero: %s", (used, expected) => {
  const report = formatCodexUsage(
    {
      rate_limit: { primary_window: { ...primary, used_percent: used } },
    },
    NOW,
  )!;
  expect(report).toContain(expected);
});

it("uses supplied relative resets without guessing a window duration", () => {
  const report = formatCodexUsage(
    {
      rate_limit: {
        primary_window: {
          used_percent: 40,
          limit_window_seconds: "18000",
          reset_after_seconds: 90,
        },
      },
    },
    NOW,
  )!;
  expect(report).toContain("Primary (duration unknown): 40% used · 60% remaining");
  expect(report).toContain("2026-01-10 12:01:30 UTC (in 1m 30s)");
});

it("reports unknown invalid reset times and never resets a measured balance locally", () => {
  const report = formatCodexUsage(
    {
      rate_limit: {
        limit_reached: true,
        primary_window: { ...primary, used_percent: 100, reset_at: NOW / 1000 - 1 },
        secondary_window: { ...primary, reset_at: Infinity },
      },
    },
    NOW,
  )!;
  expect(report).toContain("100% used · 0% remaining");
  expect(report).toContain("reset time passed; refresh usage");
  expect(report).toContain("Resets: unknown");
  expect(report).toContain("Limit reached");
});

it.each([
  [{ unlimited: true }, "unlimited"],
  [{ unlimited: true, has_credits: false }, "unlimited (unavailable)"],
  [{ has_credits: false, balance: "0" }, "0 balance (unavailable)"],
  [{ has_credits: true }, "available; balance not reported"],
  [{ has_credits: false, balance: "0x10" }, "unavailable; balance not reported"],
] as const)("reports only supplied credit facts: %j", (credits, expected) => {
  expect(formatCodexUsage({ credits }, NOW)).toContain(`Credits: ${expected}`);
});

it("includes review and additional buckets plus explicit account restrictions", () => {
  const report = formatCodexUsage(
    {
      code_review_rate_limit: { primary_window: { ...primary, limit_window_seconds: 604_800 } },
      additional_rate_limits: [
        {
          metered_feature: "codex_other",
          limit_name: "Other model pool",
          rate_limit: { allowed: false, primary_window: primary },
        },
      ],
      spend_control: { reached: true },
      rate_limit_reached_type: { type: "workspace_owner_credits_depleted" },
    },
    NOW,
  )!;
  expect(report).toContain("Code review\n  Primary (7d)");
  expect(report).toContain("Other model pool\n  Primary (30m)");
  expect(report).toContain("Requests not currently allowed");
  expect(report).toContain("Workspace spending limit: reached");
  expect(report).toContain("Account limit: workspace owner credits depleted");
});

it("bounds and sanitizes backend labels and additional-bucket output", () => {
  const payload = {
    plan_type: "plus\u001b[31m\n",
    additional_rate_limits: Array.from({ length: 10 }, (_, index) => ({
      limit_name: `Pool ${index}\r\n${"x".repeat(1000)}`,
      rate_limit: { primary_window: primary },
    })),
  };
  const report = formatCodexUsage(payload, NOW)!;
  // oxlint-disable-next-line no-control-regex -- Newlines are layout; other terminal controls must be absent.
  expect(report).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  expect(report).not.toContain("x".repeat(65));
  expect(report).toContain("2 additional entries omitted.");
  expect(report).not.toContain("Pool 8");
  expect(report.length).toBeLessThan(5000);
});

it.each([null, [], {}, { unrelated: 10 }, { rate_limit: "wrong shape" }])(
  "rejects unrecognized response shapes instead of fabricating healthy usage: %j",
  (payload) => {
    expect(formatCodexUsage(payload, NOW)).toBeUndefined();
  },
);
