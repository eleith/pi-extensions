import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "@eleith/pi-internal/commands";
import { getSettings } from "@eleith/pi-internal/config";
import { ContextController } from "./controller.ts";
import { UsageController } from "./usage-controller.ts";

export default async function codex(pi: ExtensionAPI): Promise<void> {
  const settings = await getSettings();
  const commandName = `${settings.commandPrefix}:codex`;
  const controller = new ContextController(pi, commandName);
  const usage = new UsageController();

  registerCommand(pi, {
    name: commandName,
    description: "Codex context controls and account usage",
    actions: ["extend", "restore", "usage"],
    defaultAction: "",
    handler(action, ctx) {
      if (action === "usage") return usage.report(ctx);
      return controller.handle(action, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => controller.restore(ctx));
  pi.on("session_tree", (_event, ctx) => {
    usage.cancel();
    return controller.restore(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    usage.cancel();
    return controller.modelSelected(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    usage.dispose();
    controller.shutdown(ctx);
  });
  pi.on("input", async (event, ctx) => {
    if (event.streamingBehavior === undefined && ctx.isIdle()) await controller.reconcile(ctx);
  });
}
