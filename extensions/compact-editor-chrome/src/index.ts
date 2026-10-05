import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "@eleith/pi-internal/commands";
import { getSettings } from "@eleith/pi-internal/config";
import { CompactEditorChromeController } from "./controller.ts";

export default async function compactEditorChrome(pi: ExtensionAPI): Promise<void> {
  const settings = await getSettings();
  const controller = new CompactEditorChromeController();

  registerCommand(pi, {
    name: `${settings.commandPrefix}:compact-editor-chrome`,
    description: "Compact editor chrome",
    actions: ["show", "hide", "toggle"],
    defaultAction: "toggle",
    handler(action, ctx) {
      if (action === "show") controller.show(ctx);
      else if (action === "hide") controller.hide(ctx);
      else controller.toggle(ctx);
      ctx.ui.notify(
        `Eleith compact editor chrome: ${controller.isEnabled() ? "shown" : "hidden"}`,
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => controller.sessionStarted(ctx));
  pi.on("model_select", (_event, ctx) => controller.updateContext(ctx));
  pi.on("thinking_level_select", (_event, ctx) => controller.updateContext(ctx));
  pi.on("agent_start", () => controller.requestRender());
  pi.on("agent_settled", () => controller.requestRender());
  pi.on("session_compact", () => controller.requestRender());
  pi.on("session_shutdown", (_event, ctx) => controller.dispose(ctx));
}
