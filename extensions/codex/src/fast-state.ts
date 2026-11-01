export const FAST_ENTRY = "eleith-codex-fast";

export type FastPreference = "on" | "off" | "inherit";

export interface FastChoice {
  readonly provider: string;
  readonly modelId: string;
  readonly mode: FastPreference;
}

interface Entry {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

// Replay only the supplied active branch, retaining explicit inherit tombstones.
export function readFastPreferences(branch: readonly Entry[]): Map<string, FastPreference> {
  const preferences = new Map<string, FastPreference>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== FAST_ENTRY) continue;
    if (!isFastChoice(entry.data)) continue;
    preferences.set(`${entry.data.provider}/${entry.data.modelId}`, entry.data.mode);
  }
  return preferences;
}

function isFastChoice(value: unknown): value is FastChoice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!("provider" in value) || typeof value.provider !== "string" || !value.provider.length)
    return false;
  if (!("modelId" in value) || typeof value.modelId !== "string" || !value.modelId.length)
    return false;
  if (!("mode" in value)) return false;
  return value.mode === "on" || value.mode === "off" || value.mode === "inherit";
}
