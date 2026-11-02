import type { FastEligibility } from "./capabilities.ts";
import type { FastPreference } from "./fast-state.ts";

export type RequestedTier = "priority" | "default";
export type ObservedTier = RequestedTier | "auto" | "flex" | "fast";
export type FastRequestPolicy = RequestedTier | "untouched" | "suspended" | "outside scope";

export interface FastStatus {
  preference: FastPreference;
  eligibility: FastEligibility;
  requestPolicy: FastRequestPolicy;
  lastObserved: ObservedTier | undefined;
  conflict: boolean;
}

export function formatFastStatus(status: FastStatus): string {
  let headline: string;
  switch (status.requestPolicy) {
    case "untouched":
      headline = "Fast: Provider default (no override)";
      break;
    case "default":
      headline = "Fast: Off (standard requested)";
      break;
    case "priority":
      headline = "Fast: On (priority requested)";
      break;
    case "suspended":
      headline =
        status.eligibility === "unsupported"
          ? "Fast: Paused — priority is not available for this model"
          : "Fast: Paused — model eligibility needs checking";
      break;
    case "outside scope":
      headline = "Fast: Unavailable for this model/provider";
      break;
  }
  const rows = [headline];
  if (status.lastObserved !== undefined) {
    const labels: Record<ObservedTier, string> = {
      default: "Standard",
      priority: "Priority",
      flex: "Flex",
      auto: "Automatic",
      fast: "Fast",
    };
    rows.push(`Last reported tier: ${labels[status.lastObserved]}`);
  } else if (status.requestPolicy === "priority") {
    rows.push("No response tier reported yet.");
  }
  if (status.conflict) rows.push("Last request kept another tier setting; not overridden.");
  if (status.requestPolicy === "priority") rows.push("Priority requests use more allowance.");
  return rows.join("\n");
}
