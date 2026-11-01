import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";
import { modelKey } from "./profiles.ts";

export interface ContextStatus {
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

function validWindow(value: number | null | undefined): value is number {
  return validCount(value) && value > 0;
}

function tokens(value: number | null | undefined): string {
  return validCount(value) ? TOKEN_FORMAT.format(value).toLowerCase() : "unknown";
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

function cacheSummary(message: AssistantMessage | undefined, currentModel: Model<Api>): string {
  if (!message) return "Cached input: not reported";

  const requestModel = modelKey({ provider: message.provider, id: message.model });
  const scope =
    requestModel === modelKey(currentModel)
      ? "last assistant request"
      : `last assistant request · ${requestModel}`;
  const usage = message.usage;
  let value = "not reported";
  if (
    usage &&
    validCount(usage.input) &&
    validCount(usage.cacheRead) &&
    validCount(usage.cacheWrite)
  ) {
    // Pi's uncached, cache-read and cache-write counts are disjoint; output is excluded.
    const input = usage.input + usage.cacheRead + usage.cacheWrite;
    if (Number.isFinite(input) && input > 0) {
      // Zero cache counters may be adapter defaults, not a measured cache miss.
      value =
        usage.cacheRead > 0
          ? `${tokens(usage.cacheRead)} / ${tokens(input)}`
          : `none reported · ${tokens(input)} input tokens`;
      if (usage.cacheWrite > 0) value += ` · wrote ${tokens(usage.cacheWrite)}`;
    }
  }
  return `Cached input: ${value} (${scope})`;
}

function windowLabel({ model, standardWindow, extendedWindow }: ContextStatus): string {
  if (!validWindow(model.contextWindow)) return "window unknown";
  if (!validWindow(standardWindow)) return "baseline unknown";
  if (model.contextWindow === standardWindow) return "standard";
  if (validWindow(extendedWindow) && model.contextWindow === extendedWindow) return "extended";
  return "custom";
}

/** Read-only local snapshot; the caller supplies the model header and fast-mode hint. */
export function formatContextSummary(status: ContextStatus, now = Date.now()): string {
  const { model, usage, standardWindow, extendedWindow, desiredExtended, replayPaused, branch } =
    status;
  const selectedWindow = validWindow(model.contextWindow) ? model.contextWindow : undefined;
  // Routed/virtual models may advertise a different window from the one used for compaction.
  const effectiveWindow = validWindow(usage?.contextWindow) ? usage.contextWindow : selectedWindow;
  const separateWindows = effectiveWindow !== selectedWindow;
  const label = separateWindows ? "effective" : windowLabel(status);
  const window = `${tokens(effectiveWindow)} tokens (${label})`;
  let context = validCount(usage?.tokens)
    ? `Context: ${tokens(usage.tokens)} / ${window}`
    : `Context: ${window} · usage not reported`;

  if (separateWindows) {
    context += ` · Selected context window: ${tokens(selectedWindow)} tokens (${windowLabel(status)})`;
  }
  if (desiredExtended !== undefined) {
    const desired = desiredExtended ? "extended" : "standard";
    const target = desiredExtended ? extendedWindow : standardWindow;
    if (!validWindow(target)) {
      context += ` · ${desired} desired (target unknown)`;
    } else if (selectedWindow !== target) {
      context += ` · ${desired} pending${replayPaused ? "" : " normal prompt"}`;
    }
  }
  if (replayPaused) context += " · replay paused";

  const compactions = branch.filter((entry) => entry.type === "compaction");
  const lastCompaction = compactions.at(-1);
  let compaction = `Compaction: ${compactions.length} on this branch`;
  if (lastCompaction) {
    const age = elapsed(lastCompaction.timestamp, now);
    compaction += age === "unknown" ? " · last time unknown" : ` · last ${age}`;
  }
  return [context, compaction, cacheSummary(lastAssistant(branch), model)].join("\n");
}
