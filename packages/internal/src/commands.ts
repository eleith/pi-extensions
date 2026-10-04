import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type NativeCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

interface CommandOptions {
  name: string;
  description: string;
  actions: readonly string[];
  defaultAction: string;
  handler(action: string, ctx: ExtensionCommandContext): void | Promise<void>;
}

export function registerCommand(pi: ExtensionAPI, options: CommandOptions): void {
  let registered = false;

  pi.on("session_start", (_event, ctx) => {
    if (registered) return;
    const conflict = findConflict(pi, options.name);
    if (conflict) {
      ctx.ui.notify(
        `/${options.name} was not registered: /${conflict.name} already exists. Rename/remove the conflicting command or change commandPrefix and reload.`,
        "warning",
      );
      return;
    }
    pi.registerCommand(options.name, createCommand(options));
    registered = true;
  });
}

function createCommand(options: CommandOptions): NativeCommand {
  return {
    description: `${options.description} — ${commandUsage(options)}`,
    getArgumentCompletions: (prefix) => completeActions(options.actions, prefix),
    handler: (args, ctx) => invokeCommand(options, args, ctx),
  };
}

function completeActions(actions: readonly string[], prefix: string) {
  const input = prefix.trimStart().toLowerCase();
  const matches = actions.filter((action) => action.startsWith(input));
  return matches.length ? matches.map((action) => ({ value: action, label: action })) : null;
}

async function invokeCommand(
  options: CommandOptions,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const action = args.trim().toLowerCase() || options.defaultAction;
  if (action !== options.defaultAction && !options.actions.includes(action)) {
    ctx.ui.notify(`Usage: ${commandUsage(options)}`, "warning");
    return;
  }
  await options.handler(action, ctx);
}

function findConflict(pi: ExtensionAPI, name: string) {
  return pi
    .getCommands()
    .find(
      (command) =>
        command.name === name ||
        (command.name.startsWith(`${name}:`) && /^\d+$/.test(command.name.slice(name.length + 1))),
    );
}

function commandUsage({ name, actions }: CommandOptions): string {
  return `/${name} [${actions.join("|")}]`;
}
