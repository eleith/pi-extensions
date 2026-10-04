import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "@eleith/pi-internal/commands";
import { getSettings } from "@eleith/pi-internal/config";
import { ContextController } from "./controller.ts";

export default async function contextWindow(pi: ExtensionAPI): Promise<void> {
  const settings = await getSettings();
  const commandName = `${settings.commandPrefix}:context`;
  const controller = new ContextController(pi, commandName);

  registerCommand(pi, {
    name: commandName,
    description: "Context window",
    actions: ["extend", "restore"],
    defaultAction: "",
    handler: (action, ctx) => controller.handle(action, ctx),
  });

  pi.on("session_start", (_event, ctx) => controller.restore(ctx));
  pi.on("session_tree", (_event, ctx) => controller.restore(ctx));
  pi.on("model_select", (_event, ctx) => controller.modelSelected(ctx));
  pi.on("session_shutdown", () => controller.shutdown());
  pi.on("input", async (event, ctx) => {
    // Reconcile before Pi checks pre-prompt compaction; catalogs can replace our private copy.
    if (event.streamingBehavior === undefined && ctx.isIdle()) await controller.reconcile(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => controller.reconcile(ctx));
}
