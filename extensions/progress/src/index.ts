import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "@eleith/pi-internal/commands";
import { getSettings } from "@eleith/pi-internal/config";
import { ProgressController } from "./controller.ts";
import { transportName } from "./transport.ts";

export default async function progress(pi: ExtensionAPI): Promise<void> {
  const settings = await getSettings();
  const controller = new ProgressController();

  registerCommand(pi, {
    name: `${settings.commandPrefix}:progress`,
    description: "Terminal progress",
    actions: ["on", "off", "test", "toggle"],
    defaultAction: "toggle",
    handler(action, ctx) {
      if (action === "test") {
        controller.test(ctx);
        return;
      }
      if (action === "on") controller.setEnabled(true, ctx);
      else if (action === "off") controller.setEnabled(false, ctx);
      else controller.toggle(ctx);
      ctx.ui.notify(
        `Eleith terminal progress: ${controller.isEnabled() ? "on" : "off"} (${transportName()})`,
        "info",
      );
    },
  });

  pi.on("session_start", () => controller.reset());
  pi.on("agent_start", (_event, ctx) => controller.startRun(ctx));
  pi.on("agent_settled", () => controller.settleRun());
  pi.on("session_shutdown", () => controller.dispose());
}
