import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettings } from "@eleith/pi-internal/config";
import { registerCommand } from "@eleith/pi-internal/commands";
import { ToolRenderingController } from "./controller.ts";
import { registerBashRendering } from "./bash.ts";
import { registerReadRendering } from "./read.ts";
import { registerGrepRendering } from "./grep.ts";
import { registerLsRendering } from "./ls.ts";
import { registerFindRendering } from "./find.ts";
import { registerWriteRendering } from "./write.ts";
import { registerEditRendering } from "./edit.ts";

export default async function toolRendering(pi: ExtensionAPI): Promise<void> {
  const settings = await getSettings();
  const controller = new ToolRenderingController();
  const cwd = process.cwd();
  registerBashRendering(pi, cwd, controller.state);
  registerReadRendering(pi, cwd, controller.state);
  registerGrepRendering(pi, cwd, controller.state);
  registerLsRendering(pi, cwd, controller.state);
  registerFindRendering(pi, cwd, controller.state);
  registerWriteRendering(pi, cwd, controller.state);
  registerEditRendering(pi, cwd, controller.state);
  registerCommand(pi, {
    name: `${settings.commandPrefix}:tool-rendering`,
    description: "Tool rendering chrome",
    actions: ["show", "hide", "toggle"],
    defaultAction: "toggle",
    handler: (action, ctx) => controller.command(action, ctx),
  });
  pi.on("session_start", () => controller.sessionStarted());
  pi.on("before_agent_start", () => controller.working.beforeAgentStart());
  pi.on("agent_start", () => controller.working.agentStarted());
  pi.on("before_provider_request", (_event, ctx) => controller.working.beforeProviderRequest(ctx));
  pi.on("message_end", (event) => controller.working.messageEnded(event.message.role));
  pi.on("tool_execution_end", (event) => {
    controller.state.nativeBash.stop(event.toolCallId);
    controller.state.bashTiming.stop(event.toolCallId);
  });
  pi.on("agent_settled", (_event, ctx) => controller.settled(ctx));
  pi.on("session_shutdown", (_event, ctx) => controller.dispose(ctx));
}
