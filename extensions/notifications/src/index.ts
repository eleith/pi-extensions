import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "@eleith/pi-internal/commands";
import { getSettings } from "@eleith/pi-internal/config";
import { DesktopNotifier } from "./controller.ts";

export default async function notifications(pi: ExtensionAPI): Promise<void> {
  const settings = await getSettings();
  const controller = new DesktopNotifier();

  registerCommand(pi, {
    name: `${settings.commandPrefix}:notifications`,
    description: "Desktop notifications",
    actions: ["on", "off", "test", "toggle"],
    defaultAction: "toggle",
    async handler(action, ctx) {
      if (action === "test") {
        const delivery = await controller.test(ctx);
        if (delivery !== undefined) {
          ctx.ui.notify(
            `Pi notification test: ${delivery}`,
            delivery === "none" ? "warning" : "info",
          );
        }
        return;
      }
      if (action === "on") controller.setEnabled(true);
      else if (action === "off") controller.setEnabled(false);
      else controller.toggle();
      ctx.ui.notify(`Eleith notifications: ${controller.isEnabled() ? "on" : "off"}`, "info");
    },
  });

  pi.on("session_start", () => controller.reset());
  pi.on("agent_start", () => controller.startRun());
  pi.on("agent_before_settle", (event) => controller.captureOutcome(event.outcome));
  pi.on("agent_settled", (_event, ctx) => controller.settleRun(ctx));
  pi.on("session_shutdown", () => controller.dispose());
}
