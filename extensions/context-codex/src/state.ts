// Keep the transcript identifier stable so existing context-window branch choices still replay.
export const CONTEXT_ENTRY = "eleith-context";

export interface ContextPreference {
  readonly provider: string;
  readonly modelId: string;
  readonly extended: boolean;
}

interface Entry {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

function isPreference(value: unknown): value is ContextPreference {
  if (typeof value !== "object" || value === null) return false;
  return (
    "provider" in value &&
    typeof value.provider === "string" &&
    "modelId" in value &&
    typeof value.modelId === "string" &&
    "extended" in value &&
    typeof value.extended === "boolean"
  );
}

// Read only the active branch: a choice on an abandoned branch is not this one's setting.
export function readPreferences(branch: readonly Entry[]): Map<string, boolean> {
  const preferences = new Map<string, boolean>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== CONTEXT_ENTRY || !isPreference(entry.data))
      continue;
    preferences.set(`${entry.data.provider}/${entry.data.modelId}`, entry.data.extended);
  }
  return preferences;
}
