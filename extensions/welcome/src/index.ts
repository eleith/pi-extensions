import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "@eleith/pi-internal/commands";
import { getSettings } from "@eleith/pi-internal/config";
import { WelcomeCard } from "./card.ts";
import { WelcomeController } from "./controller.ts";
import { ENTRY_TYPE, type TreeSize, type WelcomeData } from "./types.ts";

export default async function welcome(pi: ExtensionAPI): Promise<void> {
  const settings = await getSettings();
  const controller = new WelcomeController(pi);

  pi.registerEntryRenderer<WelcomeData>(ENTRY_TYPE, (entry, _options, theme) =>
    entry.data ? new WelcomeCard(entry.data, theme) : undefined,
  );
  registerCommand(pi, {
    name: `${settings.commandPrefix}:welcome`,
    description: "Welcome tree",
    actions: ["show", "auto", "large", "small", "tiny"],
    defaultAction: "auto",
    handler: (action, ctx) =>
      controller.show(ctx, action === "show" ? "auto" : (action as TreeSize)),
  });
  pi.on("session_start", (_event, ctx) => controller.sessionStarted(ctx));
  pi.on("session_tree", () => controller.sessionChanged());
  pi.on("session_shutdown", () => controller.dispose());
}
