import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "@eleith/pi-internal/commands";
import { getSettings } from "@eleith/pi-internal/config";
import { ContextController } from "./controller.ts";
import { UsageController } from "./usage-controller.ts";
import { FastController } from "./fast.ts";
import { CODEX_ACTIONS, completeCodexArguments } from "./commands.ts";
import { formatCodexDashboard } from "./dashboard.ts";
import { InspectorController } from "./inspector.ts";

export default async function codex(pi: ExtensionAPI): Promise<void> {
  const settings = await getSettings();
  const commandName = `${settings.commandPrefix}:codex`;
  const controller = new ContextController(pi, commandName);
  const inspector = new InspectorController();
  const usage = new UsageController(inspector);
  const fast = new FastController(pi, commandName);
  let disposed = false;

  registerCommand(pi, {
    name: commandName,
    description: "Context, fast requests and account allowance",
    actions: CODEX_ACTIONS,
    getArgumentCompletions: completeCodexArguments,
    argumentActions: ["context", "fast"],
    defaultAction: "",
    handler(action, ctx, argument) {
      if (disposed) return;
      const showStatus = !action || ((action === "context" || action === "fast") && !argument);
      if (showStatus) {
        const context = controller.getStatus(ctx);
        const fastStatus = fast.getStatus(ctx);
        return inspector.show(ctx, "Overview", {
          message: formatCodexDashboard(context, fastStatus, commandName),
        });
      }
      if (action === "usage") return usage.report(ctx);
      inspector.cancel();
      if (action === "context") return controller.handle(argument ?? "", ctx);
      if (action === "fast") return fast.handle(argument ?? "", ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    fast.restore(ctx);
    return controller.restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    inspector.cancel();
    fast.restore(ctx);
    return controller.restore(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    inspector.cancel();
    fast.invalidate();
    return controller.modelSelected(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    disposed = true;
    fast.dispose();
    try {
      usage.dispose();
      inspector.dispose();
    } finally {
      controller.shutdown(ctx);
    }
  });
  pi.on("input", async (event, ctx) => {
    if (event.streamingBehavior === undefined && ctx.isIdle()) {
      await controller.reconcile(ctx);
    }
  });
  pi.on("before_provider_request", (event, ctx) => fast.transform(event.payload, ctx));
  pi.on("provider_stream_event", (event, ctx) => fast.observe(event, ctx));
}
