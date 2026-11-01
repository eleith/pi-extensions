import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatCodexUsage } from "./usage.ts";

const NOW = Date.parse("2026-01-10T12:00:00Z");
const primary = {
  used_percent: 25,
  limit_window_seconds: 1800,
  reset_at: NOW / 1000 + 3600,
};
const LocalDateTimeFormat = Intl.DateTimeFormat;
let timeZone = "UTC";

beforeEach(() => {
  timeZone = "UTC";
  // Pin only the test's local zone; production must use the user's local zone.
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
    return new LocalDateTimeFormat(locales, { ...options, timeZone });
  });
});
afterEach(() => vi.restoreAllMocks());

it("formats a remaining-first account report without mutating the payload", () => {
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
Credits: 12.5 balance (available)

Codex
  30m window: 75% remaining (25% used)
    Resets: Jan 10, 2026, 13:00:00 UTC (in 1h)
  Secondary window: not reported`);
  expect(payload).toEqual(original);
});

it("summarizes absent data without inventing windows or unlimited credits", () => {
  const report = formatCodexUsage(
    {
      plan_type: "pro",
      rate_limit: null,
      code_review_rate_limit: null,
      credits: null,
    },
    NOW,
  )!;
  expect(report).toBe(`codex account usage · openai-codex
Plan: pro

Not reported: Codex quota, Code review quota, credits.`);
  expect(report).not.toMatch(/0%|5h|7d|unlimited/);
});

it("does not add an unadvertised review quota or default windows to a plan-only report", () => {
  expect(formatCodexUsage({ plan_type: "plus" }, NOW)).toBe(
    "codex account usage · openai-codex\nPlan: plus\n\nNot reported: Codex quota, credits.",
  );
});

it.each([
  [0, "100% remaining (0% used)"],
  [25, "75% remaining (25% used)"],
  [100, "0% remaining (100% used)"],
  [12.5, "87.5% remaining (12.5% used)"],
  [-1, "remaining not reported"],
  [101, "remaining not reported"],
  [NaN, "remaining not reported"],
  [Infinity, "remaining not reported"],
  ["25", "remaining not reported"],
  [null, "remaining not reported"],
  [undefined, "remaining not reported"],
] as const)("keeps invalid percentages distinct from genuine zero: %s", (used, expected) => {
  const report = formatCodexUsage(
    {
      rate_limit: { primary_window: { ...primary, used_percent: used } },
    },
    NOW,
  )!;
  expect(report).toContain(`30m window: ${expected}`);
  if (expected === "remaining not reported") expect(report).not.toContain("%");
});

it.each([
  [1800, "30m window"],
  [18_000, "5h window"],
  [604_800, "7d window"],
  [90_061, "1d 1h 1m 1s window"],
  [0, "Primary window (duration not reported)"],
  [-1, "Primary window (duration not reported)"],
  [1.5, "Primary window (duration not reported)"],
  [Number.MAX_SAFE_INTEGER + 1, "Primary window (duration not reported)"],
  ["18000", "Primary window (duration not reported)"],
  [undefined, "Primary window (duration not reported)"],
] as const)("labels only the actual advertised duration: %s", (seconds, expected) => {
  const report = formatCodexUsage(
    { rate_limit: { primary_window: { ...primary, limit_window_seconds: seconds } } },
    NOW,
  )!;
  expect(report).toContain(`${expected}: 75% remaining (25% used)`);
});

it("groups actual primary and secondary durations under their quota", () => {
  const report = formatCodexUsage(
    {
      rate_limit: {
        primary_window: { ...primary, limit_window_seconds: 18_000 },
        secondary_window: { ...primary, used_percent: 10, limit_window_seconds: 604_800 },
      },
    },
    NOW,
  )!;
  expect(report).toContain("Codex\n  5h window: 75% remaining (25% used)");
  expect(report).toContain("  7d window: 90% remaining (10% used)");
  expect(report).not.toContain("Primary");
  expect(report).not.toContain("Secondary");
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
  expect(report).toContain("Primary window (duration not reported): 60% remaining (40% used)");
  expect(report).toContain("Jan 10, 2026, 12:01:30 UTC (in 1m 30s)");
});

it.each([
  ["2026-01-10T12:00:00Z", "Jan 10, 2026, 08:00:00 EST"],
  ["2026-07-10T12:00:00Z", "Jul 10, 2026, 09:00:00 EDT"],
  ["2026-01-10T00:00:00Z", "Jan 9, 2026, 20:00:00 EST"],
])("uses local reset date, zone and relative time: %s", (now, expected) => {
  timeZone = "America/New_York";
  const report = formatCodexUsage(
    { rate_limit: { primary_window: { reset_after_seconds: 3600 } } },
    Date.parse(now),
  )!;
  expect(report).toContain(`Resets: ${expected} (in 1h)`);
  expect(report).toContain("remaining not reported");
  expect(report).not.toContain("UTC");
});

it("prefers an absolute reset to a conflicting relative reset", () => {
  const report = formatCodexUsage(
    { rate_limit: { primary_window: { ...primary, reset_after_seconds: 90 } } },
    NOW,
  )!;
  expect(report).toContain("Jan 10, 2026, 13:00:00 UTC (in 1h)");
  expect(report).not.toContain("in 1m 30s");
});

it("reports invalid resets as unknown and never renews a measured balance locally", () => {
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
  expect(report).toContain("0% remaining (100% used)");
  expect(report).toContain("Jan 10, 2026, 11:59:59 UTC (reset time passed; refresh usage)");
  expect(report).toContain("Resets: unknown");
  expect(report.indexOf("Codex: limit reached")).toBeLessThan(report.indexOf("\nCodex\n"));
  expect(report).not.toContain("100% remaining");
});

it.each([
  {},
  { reset_at: "1768050000" },
  { reset_at: 1e20, reset_after_seconds: 60 },
  { reset_after_seconds: -1 },
  { reset_after_seconds: "60" },
])("does not fabricate a reset from missing or invalid values: %j", (reset) => {
  expect(
    formatCodexUsage({ rate_limit: { primary_window: { used_percent: 25, ...reset } } }, NOW),
  ).toContain("Resets: unknown");
});

it("treats a reset exactly at now as expired without claiming renewal", () => {
  const report = formatCodexUsage(
    { rate_limit: { primary_window: { used_percent: 100, reset_after_seconds: 0 } } },
    NOW,
  )!;
  expect(report).toContain("0% remaining (100% used)");
  expect(report).toContain("reset time passed; refresh usage");
});

it.each([
  [{ unlimited: true }, "unlimited"],
  [{ unlimited: true, has_credits: false }, "unlimited (unavailable)"],
  [{ has_credits: false, balance: "0" }, "0 balance (unavailable)"],
  [{ has_credits: true }, "available; balance not reported"],
  [{ has_credits: false, balance: "0x10" }, "unavailable; balance not reported"],
  [{ balance: 0 }, "0 balance (availability unknown)"],
  [{ balance: -1 }, "availability unknown; balance not reported"],
  [{ balance: Infinity }, "availability unknown; balance not reported"],
  [{ balance: "1e3" }, "availability unknown; balance not reported"],
  [{ balance: " 12.50 " }, "12.5 balance (availability unknown)"],
  [{ unlimited: "true", has_credits: "true" }, "availability unknown; balance not reported"],
] as const)("reports only supplied credit facts: %j", (credits, expected) => {
  expect(formatCodexUsage({ credits }, NOW)).toContain(`Credits: ${expected}`);
});

it("puts spending, account and all bucket restrictions before healthy quotas", () => {
  const report = formatCodexUsage(
    {
      rate_limit: { primary_window: primary },
      code_review_rate_limit: {
        limit_reached: true,
        allowed: false,
        primary_window: { ...primary, limit_window_seconds: 604_800 },
      },
      additional_rate_limits: [
        {
          metered_feature: "codex_other",
          limit_name: "Other model pool",
          rate_limit: { allowed: false, primary_window: primary },
        },
      ],
      credits: { has_credits: false, balance: "0" },
      spend_control: { reached: true },
      rate_limit_reached_type: { type: "workspace_owner_credits_depleted" },
    },
    NOW,
  )!;
  expect(report.startsWith("codex account usage · openai-codex\n")).toBe(true);
  for (const warning of [
    "Workspace spending limit: reached",
    "Account limit: workspace owner credits depleted",
    "Code review: limit reached; requests not currently allowed",
    "Other model pool: requests not currently allowed",
    "Credits: 0 balance (unavailable)",
  ]) {
    expect(report).toContain(warning);
    expect(report.indexOf(warning)).toBeLessThan(report.indexOf("\nCodex\n"));
  }
  expect(report.indexOf("Workspace spending limit")).toBeLessThan(report.indexOf("Code review:"));
  expect(report).toContain("Code review\n  7d window: 75% remaining (25% used)");
  expect(report).toContain("Other model pool\n  30m window: 75% remaining (25% used)");
});

it("keeps access restrictions visible even when all quota windows are absent", () => {
  const report = formatCodexUsage(
    {
      rate_limit: { allowed: false },
      code_review_rate_limit: { limit_reached: true },
      additional_rate_limits: [{ metered_feature: "Extra", rate_limit: { allowed: false } }],
    },
    NOW,
  )!;
  expect(report).toBe(`codex account usage · openai-codex
Plan: unknown

Codex: requests not currently allowed
Code review: limit reached
Extra: requests not currently allowed

Not reported: Codex quota, Code review quota, Extra quota, credits.`);
});

it("does not interpret truthy restriction values as explicit restrictions", () => {
  const report = formatCodexUsage(
    {
      rate_limit: { allowed: "false", limit_reached: "true" },
      spend_control: { reached: "true" },
      rate_limit_reached_type: { type: 123 },
    },
    NOW,
  )!;
  expect(report).not.toMatch(
    /requests not currently allowed|limit reached|spending limit|Account limit/,
  );
  expect(report).toContain("Not reported: Codex quota, credits.");
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

it("sanitizes restriction labels and retains additional-bucket name fallbacks", () => {
  const report = formatCodexUsage(
    {
      rate_limit_reached_type: { type: "owner\r\ncredits\u001bdepleted" },
      additional_rate_limits: [
        { limit_name: "\n", metered_feature: "Fallback\tpool", rate_limit: { allowed: false } },
        null,
        { limit_name: 42, metered_feature: false },
      ],
    },
    NOW,
  )!;
  expect(report).toContain("Account limit: owner credits depleted");
  expect(report).toContain("Fallback pool: requests not currently allowed");
  expect(report).toContain(
    "Not reported: Codex quota, Fallback pool quota, Additional 2 quota, Additional 3 quota, credits.",
  );
});

it.each([null, [], {}, { unrelated: 10 }, { rate_limit: "wrong shape" }])(
  "rejects unrecognized response shapes instead of fabricating healthy usage: %j",
  (payload) => {
    expect(formatCodexUsage(payload, NOW)).toBeUndefined();
  },
);
