import { expect, it } from "vitest";
import { formatFastStatus, type FastStatus, type ObservedTier } from "./fast-status.ts";

it("leaves provider default brief without unknown fields, commands or cost warnings", () => {
  const fast = createFastStatusFixture();
  expect(formatFastStatus(fast)).toBe("Fast: Provider default (no override)");
});

it("describes off as a standard request, not an observed processing tier", () => {
  const fast = createFastStatusFixture({ preference: "off", requestPolicy: "default" });
  expect(formatFastStatus(fast)).toBe("Fast: Off (standard requested)");
});

it("describes a saved on choice as priority without eligibility state or a reported tier", () => {
  const fast = createFastStatusFixture({
    preference: "on",
    requestPolicy: "priority",
  });
  expect(formatFastStatus(fast).split("\n")).toEqual([
    "Fast: On (priority requested)",
    "No response tier reported yet.",
    "Priority requests use more allowance.",
  ]);
});

it("keeps next-request priority separate from a reported standard tier", () => {
  const fast = createFastStatusFixture({
    preference: "on",
    requestPolicy: "priority",
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

it("keeps a saved on choice intact outside scope and shows priority again when in scope", () => {
  const fast = createFastStatusFixture({
    preference: "on",
    requestPolicy: "outside scope",
  });
  expect(formatFastStatus(fast)).toBe("Fast: Unavailable for this model/provider");
  expect(fast.preference).toBe("on");
  expect(formatFastStatus({ ...fast, requestPolicy: "priority" })).toBe(
    "Fast: On (priority requested)\nNo response tier reported yet.\nPriority requests use more allowance.",
  );
});

it.each(["priority", "default"] as const)(
  "reports a past conflict separately without suspending the next %s request",
  (requestPolicy) => {
    const fast = createFastStatusFixture({
      preference: requestPolicy === "priority" ? "on" : "off",
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

function createFastStatusFixture(overrides: Partial<FastStatus> = {}): FastStatus {
  return {
    preference: "inherit",
    requestPolicy: "untouched",
    lastObserved: undefined,
    conflict: false,
    ...overrides,
  };
}
