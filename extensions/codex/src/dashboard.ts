import { formatContextSummary, type ContextStatus } from "./status.ts";
import { formatFastStatus, type FastStatus } from "./fast-status.ts";
import { modelKey } from "./profiles.ts";

/** Local snapshots only: opening the dashboard never fetches account data. */
export function formatCodexDashboard(
  context: ContextStatus | undefined,
  fast: FastStatus | undefined,
  commandName: string,
  now = Date.now(),
): string {
  if (!context) return "No model selected.";
  let fastSummary = "Fast: unavailable";
  if (fast) fastSummary = formatFastStatus(fast);
  return [
    `Codex · ${modelKey(context.model)}`,
    fastSummary,
    formatContextSummary(context, now),
    "",
    `/${commandName} usage — account allowance`,
    `/${commandName} extend|restore — context window`,
    `/${commandName} fast — priority controls (type "fast o" for on/off suggestions)`,
  ].join("\n");
}
