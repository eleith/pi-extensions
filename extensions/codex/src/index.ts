import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "@eleith/pi-internal/commands";
import { getSettings } from "@eleith/pi-internal/config";
import { ContextController } from "./controller.ts";
import { UsageController } from "./usage-controller.ts";
import { FastController } from "./fast.ts";

export default async function codex(pi: ExtensionAPI): Promise<void> {
  const settings = await getSettings();
  const commandName = `${settings.commandPrefix}:codex`;
  const controller = new ContextController(pi, commandName);
  const usage = new UsageController();
  const fast = new FastController(pi, commandName);

  registerCommand(pi, {
    name: commandName,
    description: "Codex context, account usage and fast controls",
    actions: ["extend", "restore", "usage", "fast"],
    argumentActions: ["fast"],
    defaultAction: "",
    handler(action, ctx, argument) {
      if (action === "usage") return usage.report(ctx);
      if (action === "fast") return fast.handle(argument ?? "", ctx);
      return controller.handle(action, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    fast.restore(ctx);
    return controller.restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    usage.cancel();
    fast.restore(ctx);
    return controller.restore(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    usage.cancel();
    fast.invalidate();
    return controller.modelSelected(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    usage.dispose();
    fast.dispose();
    controller.shutdown(ctx);
  });
  pi.on("input", async (event, ctx) => {
    if (event.streamingBehavior === undefined && ctx.isIdle()) {
      await controller.reconcile(ctx);
      await fast.prepare(ctx);
    }
  });
  pi.on("before_provider_request", (event, ctx) => fast.transform(event.payload, ctx));
  pi.on("provider_stream_event", (event, ctx) => fast.observe(event, ctx));
}
