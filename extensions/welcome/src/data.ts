import { basename, sep } from "node:path";
import { homedir } from "node:os";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { safe, summarize } from "./format.ts";
import { getBranchLabel } from "./git.ts";
import type { WelcomeAPI, WelcomeData, WelcomeHost } from "./types.ts";

export async function collect(
  pi: WelcomeAPI,
  ctx: WelcomeHost,
  signal: AbortSignal,
  readBranch: typeof getBranchLabel = getBranchLabel,
  loadContext: typeof loadProjectContextFiles = loadProjectContextFiles,
): Promise<WelcomeData> {
  const cwd = ctx.cwd;
  const home = homedir();
  const directory = cwd === home || cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : cwd;
  const commands = pi.getCommands();
  let context = "0 found";
  try {
    context = summarize(
      loadContext({ cwd, agentDir: getAgentDir() }).map((file) => basename(file.path)),
    );
  } catch {
    context = "unavailable";
  }
  // Capture plain data before the Git reads can outlive this event context.
  const data: WelcomeData = {
    directory: safe(directory),
    session: safe(ctx.sessionManager.getSessionName() || ""),
    model: safe(ctx.model ? `${ctx.model.provider} / ${ctx.model.id}` : "no model selected"),
    contextWindow: ctx.model?.contextWindow,
    thinking: ctx.thinkingLevel,
    context,
    skills: summarize(
      commands.filter((command) => command.source === "skill").map((command) => command.name),
    ),
    prompts: summarize(
      commands.filter((command) => command.source === "prompt").map((command) => command.name),
      "/",
    ),
    tools: `${pi.getActiveTools().length} active / ${pi.getAllTools().length} available`,
  };
  return { ...data, branch: await readBranch(cwd, signal) };
}
