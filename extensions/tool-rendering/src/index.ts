import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { getSettings } from "@eleith/pi-internal/config";
import { registerCommand } from "@eleith/pi-internal/commands";
import { ToolRenderingController } from "./controller.ts";
import { buildBashRendering } from "./bash.ts";
import { buildReadRendering } from "./read.ts";
import { buildGrepRendering } from "./grep.ts";
import { buildLsRendering } from "./ls.ts";
import { buildFindRendering } from "./find.ts";
import { buildWriteRendering } from "./write.ts";
import { buildEditRendering } from "./edit.ts";

export default async function toolRendering(pi: ExtensionAPI): Promise<void> {
  const settings = await getSettings();
  const controller = new ToolRenderingController();
  const renderers = {
    bash: buildBashRendering(controller.state),
    read: buildReadRendering(),
    grep: buildGrepRendering(),
    ls: buildLsRendering(),
    find: buildFindRendering(),
    write: buildWriteRendering(),
    edit: buildEditRendering(),
  };
  pi.registerToolRenderer((name, next) => {
    if (!controller.state.enabled || !Object.hasOwn(renderers, name)) return next();
    // Each resolved bundle keeps its style; commands affect subsequent rows only.
    // The resolver's public interface erases each tool's argument/detail types.
    return renderers[name as keyof typeof renderers] as ToolRenderers;
  });
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
    controller.state.bashTiming.stop(event.toolCallId);
  });
  pi.on("agent_settled", (_event, ctx) => controller.settled(ctx));
  pi.on("session_shutdown", (_event, ctx) => controller.dispose(ctx));
}
