import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";
import { modelKey } from "./profiles.ts";

interface ContextStatus {
  readonly model: Model<Api>;
  readonly usage: ContextUsage | undefined;
  readonly standardWindow: number | undefined;
  readonly desiredExtended?: boolean;
  readonly replayPaused?: boolean;
  readonly extendedWindow: number | undefined;
  readonly branch: readonly SessionEntry[];
}

const TOKEN_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 0,
});

function validCount(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function tokens(value: number | null | undefined): string {
  return validCount(value) ? TOKEN_FORMAT.format(value).toLowerCase() : "unknown";
}

function row(label: string, value: string): string {
  return `    ${label.padEnd(18)}${value}`;
}

function elapsed(timestamp: string, now: number): string {
  const seconds = Math.floor((now - Date.parse(timestamp)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 60) return "just now";
  const [count, unit] =
    seconds < 3600
      ? [Math.floor(seconds / 60), "minute"]
      : seconds < 86400
        ? [Math.floor(seconds / 3600), "hour"]
        : [Math.floor(seconds / 86400), "day"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

function lastAssistant(branch: readonly SessionEntry[]): AssistantMessage | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "message" && entry.message.role === "assistant") return entry.message;
  }
  return undefined;
}

function cacheRows(message: AssistantMessage | undefined, currentModel: Model<Api>): string[] {
  if (!message) return [row("Cached input", "not reported")];

  const rows: string[] = [];
  const requestModel = modelKey({ provider: message.provider, id: message.model });
  if (requestModel !== modelKey(currentModel)) rows.push(row("Model", requestModel));

  const usage = message.usage;
  // Pi normalizes input into disjoint uncached, cache-read, and cache-write counts.
  // An all-zero placeholder (e.g. a failed request) is not evidence of a cache miss.
  if (
    !usage ||
    !validCount(usage.input) ||
    !validCount(usage.cacheRead) ||
    !validCount(usage.cacheWrite)
  ) {
    return [...rows, row("Cached input", "not reported")];
  }
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!Number.isFinite(input) || input === 0) return [...rows, row("Cached input", "not reported")];

  // Some adapters also normalize absent cache counters to zero. Don't claim we
  // know whether that means a measured miss or a provider without cache metrics.
  rows.push(
    row(
      "Cached input",
      usage.cacheRead > 0
        ? `${tokens(usage.cacheRead)} / ${tokens(input)} input tokens`
        : `none reported (${tokens(input)} input tokens)`,
    ),
  );
  if (usage.cacheWrite > 0) rows.push(row("Cache writes", `${tokens(usage.cacheWrite)} tokens`));
  return rows;
}

/** Read-only report: no settings-file guesses, provider calls, or preference changes. */
export function formatContextStatus(status: ContextStatus, now = Date.now()): string {
  const { model, usage, standardWindow, extendedWindow, branch, desiredExtended, replayPaused } =
    status;
  const lines = [
    `context · ${modelKey(model)}`,
    "",
    "  window",
    row(
      "Usage",
      `${tokens(usage?.tokens)} / ${tokens(usage?.contextWindow ?? model.contextWindow)}`,
    ),
    row("Standard", tokens(standardWindow)),
  ];

  if (standardWindow === undefined) {
    lines.push(row("Baseline", "unknown; reselect a catalog model"));
  } else if (extendedWindow === standardWindow) {
    lines.push(row("Baseline", "catalog; no smaller default known"));
  }

  if (desiredExtended !== undefined) {
    const preference = desiredExtended ? "extended" : "standard";
    lines.push(row("Branch preference", `${preference} (desired, not a receipt)`));
  }
  if (replayPaused) {
    lines.push(row("Automatic replay", "paused; explicitly extend or restore"));
  }

  const extendedLabel =
    extendedWindow === undefined ? "not configured" : `${tokens(extendedWindow)} (local window)`;
  lines.push(row("Extended", extendedLabel));

  const compactions = branch.filter((entry) => entry.type === "compaction");
  const lastCompaction = compactions.at(-1);
  const lastCompacted = lastCompaction
    ? elapsed(lastCompaction.timestamp, now)
    : "never on this branch";
  lines.push(
    "",
    "  compaction",
    row("Compactions", `${compactions.length} on this branch`),
    row("Last compacted", lastCompacted),
    "",
    "  cache · last assistant request",
    ...cacheRows(lastAssistant(branch), model),
  );
  return lines.join("\n");
}
