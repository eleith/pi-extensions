import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "@eleith/pi-internal/commands";
import { getSettings } from "@eleith/pi-internal/config";
import { TitleController } from "./controller.ts";

export default async function titleStatus(pi: ExtensionAPI): Promise<void> {
  const settings = await getSettings();
  const controller = new TitleController(() => pi.getSessionName());

  registerCommand(pi, {
    name: `${settings.commandPrefix}:title-status`,
    description: "Terminal title status",
    actions: ["show", "hide", "toggle"],
    defaultAction: "toggle",
    handler(action, ctx) {
      if (action === "show") controller.show(ctx);
      else if (action === "hide") controller.hide(ctx);
      else controller.toggle(ctx);
      ctx.ui.notify(`Eleith title status: ${controller.isEnabled() ? "shown" : "hidden"}`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => controller.sessionStarted(ctx));
  pi.on("session_info_changed", (_event, ctx) => controller.sessionInfoChanged(ctx));
  pi.on("agent_start", (_event, ctx) => controller.startRun(ctx));
  pi.on("agent_settled", (_event, ctx) => controller.settleRun(ctx));
  pi.on("session_shutdown", () => controller.dispose());
}
