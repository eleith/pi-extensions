import { expect, it } from "vitest";
import { formatFastStatus, type FastStatus } from "./fast-status.ts";

const suspended: FastStatus = {
  preference: "on",
  eligibility: "unknown",
  requestPolicy: "suspended",
  lastRequested: undefined,
  lastObserved: undefined,
  conflict: false,
};

it("labels unknown delivery and explains selected scope, allowance consumption and cost-estimate limits", () => {
  const text = formatFastStatus(suspended);
  expect(text.split("\n")).toEqual([
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

it("keeps requested and observed tiers distinct and adds the conflict note only when needed", () => {
  const status: FastStatus = {
    ...suspended,
    eligibility: "supported",
    requestPolicy: "priority",
    lastRequested: "priority",
    lastObserved: "default",
  };
  const text = formatFastStatus(status);
  expect(text).toContain("Last requested tier: priority\nLast observed tier: default");
  expect(text).not.toContain("Tier conflict:");
  expect(formatFastStatus({ ...status, conflict: true })).toContain(
    "Tier conflict: an existing non-owned tier was left untouched.",
  );
});
