import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type NativeCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

export const CODEX_ACTIONS = ["extend", "restore", "usage", "fast"] as const;

const ACTION_HELP: Record<(typeof CODEX_ACTIONS)[number], string> = {
  extend: "Extend the context window for the current supported Codex model",
  restore: "Restore the standard context window",
  usage: "Show account usage and allowance limits",
  fast: "Show fast mode and its controls",
};

const FAST_HELP = [
  { action: "on", description: "Request priority processing (uses more allowance)" },
  { action: "off", description: "Request standard processing instead of priority" },
  { action: "toggle", description: "Switch fast mode on or off" },
  { action: "status", description: "Show detailed fast-mode diagnostics" },
  { action: "reset", description: "Return to the provider's default for this model" },
] as const;

export const completeCodexArguments: NonNullable<NativeCommand["getArgumentCompletions"]> = (
  prefix,
) => {
  const input = prefix.trimStart().toLowerCase();
  const split = input.search(/\s/);
  if (split < 0) {
    const matches = CODEX_ACTIONS.filter((action) => action.startsWith(input));
    return matches.length
      ? matches.map((action) => ({
          value: action,
          label: action,
          description: ACTION_HELP[action],
        }))
      : null;
  }

  if (input.slice(0, split) !== "fast") return null;
  const argument = input.slice(split).trimStart();
  if (/\s/.test(argument)) return null;
  const matches = FAST_HELP.filter(({ action }) => action.startsWith(argument));
  return matches.length
    ? matches.map(({ action, description }) => ({
        value: `fast ${action}`,
        label: action,
        description,
      }))
    : null;
};
