import { expect, it } from "vitest";
import {
  formatFastDiagnostics,
  formatFastStatus,
  type FastStatus,
  type ObservedTier,
} from "./fast-status.ts";

it("leaves provider default brief without unknown fields, commands or cost warnings", () => {
  const fast = createFastStatusFixture();
  expect(formatFastStatus(fast)).toBe("Fast: Provider default (no override)");
});

it("describes off as a standard request, not an observed processing tier", () => {
  const fast = createFastStatusFixture({ preference: "off", requestPolicy: "default" });
  expect(formatFastStatus(fast)).toBe("Fast: Off (standard requested)");
});

it("describes on as a priority request without claiming priority was delivered", () => {
  const fast = createFastStatusFixture({
    preference: "on",
    eligibility: "supported",
    requestPolicy: "priority",
    lastRequested: "priority",
  });
  expect(formatFastStatus(fast).split("\n")).toEqual([
    "Fast: On (priority requested)",
    "No response tier reported yet.",
    "Priority requests use more allowance.",
  ]);
});

it("keeps requested priority separate from a reported standard tier", () => {
  const fast = createFastStatusFixture({
    preference: "on",
    eligibility: "supported",
    requestPolicy: "priority",
    lastRequested: "priority",
    lastObserved: "default",
  });
  expect(formatFastStatus(fast).split("\n")).toEqual([
    "Fast: On (priority requested)",
    "Last reported tier: Standard",
    "Priority requests use more allowance.",
  ]);
});

it.each<[ObservedTier, string]>([
  ["default", "Standard"],
  ["priority", "Priority"],
  ["flex", "Flex"],
  ["auto", "Automatic"],
  ["fast", "Fast"],
])("labels the known reported tier %s as %s even without an override", (tier, label) => {
  const fast = createFastStatusFixture({ lastObserved: tier });
  expect(formatFastStatus(fast)).toBe(
    `Fast: Provider default (no override)\nLast reported tier: ${label}`,
  );
});

it("pauses a saved on choice when eligibility needs checking without claiming a current request", () => {
  const fast = createFastStatusFixture({
    preference: "on",
    requestPolicy: "suspended",
    lastRequested: "priority",
  });
  expect(formatFastStatus(fast)).toBe("Fast: Paused — model eligibility needs checking");
});

it("explains when priority is not available without erasing the saved preference", () => {
  const fast = createFastStatusFixture({
    preference: "on",
    eligibility: "unsupported",
    requestPolicy: "suspended",
    lastObserved: "default",
  });
  expect(formatFastStatus(fast)).toBe(
    "Fast: Paused — priority is not available for this model\nLast reported tier: Standard",
  );
  expect(fast.preference).toBe("on");
});

it("gives outside scope precedence over the saved on preference and old requested tier", () => {
  const fast = createFastStatusFixture({
    preference: "on",
    eligibility: "supported",
    requestPolicy: "outside scope",
    lastRequested: "priority",
  });
  expect(formatFastStatus(fast)).toBe("Fast: Unavailable for this model/provider");
});

it.each(["priority", "default"] as const)(
  "reports a past conflict separately without suspending the next %s request",
  (requestPolicy) => {
    const fast = createFastStatusFixture({
      preference: requestPolicy === "priority" ? "on" : "off",
      eligibility: "supported",
      requestPolicy,
      lastObserved: "flex",
      conflict: true,
    });
    const headline =
      requestPolicy === "priority"
        ? "Fast: On (priority requested)"
        : "Fast: Off (standard requested)";
    const rows = [
      headline,
      "Last reported tier: Flex",
      "Last request kept another tier setting; not overridden.",
    ];
    if (requestPolicy === "priority") rows.push("Priority requests use more allowance.");
    expect(formatFastStatus(fast).split("\n")).toEqual(rows);
    expect(formatFastStatus({ ...fast, conflict: false })).not.toContain(
      "Last request kept another tier setting",
    );
  },
);

it("preserves unknown delivery and the full scope, allowance and cost-estimate diagnostics", () => {
  const fast = createFastStatusFixture({ preference: "on", requestPolicy: "suspended" });
  expect(formatFastDiagnostics(fast).split("\n")).toEqual([
    "Codex fast mode (selected model)",
    "Preference: on",
    "Eligibility: unknown",
    "Next request policy: suspended",
    "Last requested tier: unknown",
    "Last observed tier: unknown",
    "Scope: direct legacy Codex; may include retries, compaction and cache warming. Selected scope is not physical-request identity.",
    "Priority uses more allowance. Pi's cost estimate may miss priority pricing when response tier metadata is absent or normalized.",
    "Observed tier is model-scoped, not a receipt for the last requested tier.",
  ]);
});

it("preserves distinct requested and observed diagnostics and the original optional conflict note", () => {
  const fast = createFastStatusFixture({
    preference: "on",
    eligibility: "supported",
    requestPolicy: "priority",
    lastRequested: "priority",
    lastObserved: "default",
    conflict: true,
  });
  expect(formatFastDiagnostics(fast).split("\n")).toEqual([
    "Codex fast mode (selected model)",
    "Preference: on",
    "Eligibility: supported",
    "Next request policy: priority",
    "Last requested tier: priority",
    "Last observed tier: default",
    "Tier conflict: an existing non-owned tier was left untouched.",
    "Scope: direct legacy Codex; may include retries, compaction and cache warming. Selected scope is not physical-request identity.",
    "Priority uses more allowance. Pi's cost estimate may miss priority pricing when response tier metadata is absent or normalized.",
    "Observed tier is model-scoped, not a receipt for the last requested tier.",
  ]);
  expect(formatFastDiagnostics({ ...fast, conflict: false })).not.toContain("Tier conflict:");
});

function createFastStatusFixture(overrides: Partial<FastStatus> = {}): FastStatus {
  return {
    preference: "inherit",
    eligibility: "unknown",
    requestPolicy: "untouched",
    lastRequested: undefined,
    lastObserved: undefined,
    conflict: false,
    ...overrides,
  };
}
