import {
  createBashToolDefinition,
  type AgentToolResult,
  type BashToolInput,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  frameComponent,
  formatDuration,
  frameResultWithBottomLabel,
  frameStatus,
  frameTop,
  resultLabel,
} from "./frame.ts";
import { textFromResult } from "./tool-result.ts";
import { moreLines, previewLines } from "./preview.ts";
import type { RenderingState } from "./state.ts";
import { bashElapsed } from "./bash-timing.ts";

type BuiltinBashTool = ReturnType<typeof createBashToolDefinition>;
type BashRenderCall = NonNullable<BuiltinBashTool["renderCall"]>;
type BashRenderResult = NonNullable<BuiltinBashTool["renderResult"]>;
type BashRenderContext = Parameters<BashRenderResult>[3];
type BashRenderOptions = Parameters<BashRenderResult>[1];
type BashTheme = Parameters<BashRenderResult>[2];

export function registerBashRendering(pi: ExtensionAPI, cwd: string, state: RenderingState): void {
  const original = createBashToolDefinition(cwd);

  const renderCall: BashRenderCall = (args, theme, context) => {
    if (!state.enabled && original.renderCall)
      return state.nativeBash.renderCall(original.renderCall, args, theme, context);
    const command = typeof args?.command === "string" ? args.command : "";
    const titleArgs = { ...args, command };
    const status = frameStatus(context);
    const expanded = context.expanded;
    return frameComponent(
      context,
      (width) =>
        `${frameTop(buildBashTitle(titleArgs, theme), status, theme, width)}\n${renderCommand(command, expanded, theme)}`,
    );
  };

  const renderResult: BashRenderResult = (result, options, theme, context) => {
    if (!state.enabled && original.renderResult) {
      return state.nativeBash.renderResult(original.renderResult, result, options, theme, context);
    }
    state.bashTiming.update(context, options);
    const { state: rowState, isError, isPartial } = context;
    const paintContext = { state: rowState, isError, isPartial };
    return frameComponent(context, (width) =>
      renderBashResult(result, options, theme, paintContext, width),
    );
  };

  pi.registerTool({
    ...original,
    renderShell: "self",
    renderCall,
    renderResult,
  });
}

function buildBashTitle(args: BashToolInput, theme: BashTheme): string {
  const timeout = args.timeout ? ` ${theme.fg("muted", `(${args.timeout}s timeout)`)}` : "";
  return `${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("accent", commandLabel(args.command ?? ""))}${timeout}`;
}

function commandLabel(command: string): string {
  return firstCommandWord(command) ?? "command";
}

function firstCommandWord(command: string): string | undefined {
  const firstLine = command
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
  return firstLine?.match(/^[^\s;&|()]+/)?.[0];
}

function renderBashResult(
  result: AgentToolResult<unknown>,
  options: BashRenderOptions,
  theme: BashTheme,
  context: Pick<BashRenderContext, "state" | "isError" | "isPartial">,
  width: number,
): string {
  const status = frameStatus(context);
  const elapsedMs = bashElapsed(context.state);
  const rawOutput = textFromResult(result);
  // Only failed commands have a Pi status line; success and partial stdout are arbitrary text.
  const parsed = context.isError
    ? parseBashOutput(rawOutput, null)
    : { body: rawOutput, exitCode: options.isPartial ? null : 0, timedOut: false, aborted: false };
  const { body, hidden } = previewBashOutput(parsed.body, options.expanded);
  const output = context.isError && body ? theme.fg("error", body) : body;
  const duration = elapsedMs === undefined ? "" : theme.fg("dim", formatDuration(elapsedMs));
  const runStatus = options.isPartial
    ? theme.fg("warning", body ? "running" : "running · no output yet")
    : bashSummaryLabel(parsed, theme) || (context.isError ? theme.fg("error", "✗ error") : "");
  const summary = [duration, runStatus].filter(Boolean).join(theme.fg("dim", " · "));
  const label = resultLabel(summary, options.expanded, hidden, theme);
  return frameResultWithBottomLabel(output, label, status, theme, width);
}

interface ParsedBashOutput {
  readonly body: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

function parseBashOutput(output: string, fallbackExitCode: number | null): ParsedBashOutput {
  const tail = output.match(
    /(?:\n\n|^)Command (?:exited with code (\d+)|timed out after \d+ seconds|aborted)\s*$/,
  );
  if (!tail) return { body: output, exitCode: fallbackExitCode, timedOut: false, aborted: false };

  const tailText = tail[0];
  return {
    body: output.slice(0, tail.index),
    exitCode: tail[1] ? Number(tail[1]) : fallbackExitCode,
    timedOut: /timed out/.test(tailText),
    aborted: /aborted/.test(tailText),
  };
}

function bashSummaryLabel(parsed: ParsedBashOutput, theme: BashTheme): string {
  if (parsed.timedOut) return theme.fg("warning", "⚡ timed out");
  if (parsed.aborted) return theme.fg("warning", "⚡ aborted");
  if (parsed.exitCode === null) return "";
  return parsed.exitCode === 0
    ? theme.fg("success", "✓ exit 0")
    : theme.fg("error", `✗ exit ${parsed.exitCode}`);
}

function renderCommand(command: string, expanded: boolean, theme: BashTheme): string {
  const lines = command.trimEnd().split("\n");
  if (lines.length === 1 && lines[0]?.trim() === "") return "";
  const { shown, hidden } = previewLines(lines, expanded, 5);
  const body = shown
    .map((line, index) => {
      const prompt = index === 0 ? "$ " : "> ";
      return `${theme.fg("dim", prompt)}${theme.fg("toolOutput", line)}`;
    })
    .join("\n");
  return hidden ? `${body}\n${moreLines(hidden, theme)}` : body;
}

function previewBashOutput(body: string, expanded: boolean): { body: string; hidden: number } {
  // A final newline terminates the last output line; it isn't another blank line.
  const displayBody = body.replace(/\r?\n$/, "");
  const lines = displayBody ? displayBody.split("\n") : [];
  const hidden = expanded ? 0 : Math.max(0, lines.length - 5);
  return { body: hidden ? lines.slice(-5).join("\n") : displayBody, hidden };
}
