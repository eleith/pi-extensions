import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type NativeCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

export const CODEX_ACTIONS = ["context", "fast", "usage"] as const;

const ACTION_HELP: Record<(typeof CODEX_ACTIONS)[number], string> = {
  context: "Control the local context window",
  fast: "Control priority processing and allowance use",
  usage: "Show account usage and allowance limits",
};

const CONTROL_HELP = {
  context: [
    { action: "on", description: "Use the larger local context window" },
    { action: "off", description: "Use the catalog baseline context window" },
    {
      action: "toggle",
      description: "Switch between the larger local window and catalog baseline",
    },
  ],
  fast: [
    { action: "on", description: "Request priority processing (uses more allowance)" },
    { action: "off", description: "Request standard processing instead of priority" },
    { action: "toggle", description: "Switch fast mode on or off" },
  ],
} as const;

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

  const group = input.slice(0, split);
  if (group !== "context" && group !== "fast") return null;
  const argument = input.slice(split).trimStart();
  if (/\s/.test(argument)) return null;
  const matches = CONTROL_HELP[group].filter(({ action }) => action.startsWith(argument));
  return matches.length
    ? matches.map(({ action, description }) => ({
        value: `${group} ${action}`,
        label: action,
        description,
      }))
    : null;
};
