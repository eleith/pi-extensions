import {
  createGrepToolDefinition,
  type AgentToolResult,
  type ExtensionAPI,
  type GrepToolDetails,
  type GrepToolInput,
} from "@earendil-works/pi-coding-agent";
import {
  builtinContext,
  frameComponent,
  frameResultWithBottomLabel,
  frameStatus,
  frameToolError,
  frameTop,
  resultLabel,
} from "./frame.ts";
import { normalizeLineEndings, textFromResult } from "./tool-result.ts";
import type { RenderingState } from "./state.ts";

type BuiltinGrepTool = ReturnType<typeof createGrepToolDefinition>;
type GrepRenderCall = NonNullable<BuiltinGrepTool["renderCall"]>;
type GrepRenderResult = NonNullable<BuiltinGrepTool["renderResult"]>;
type GrepTheme = Parameters<GrepRenderResult>[2];

export function registerGrepRendering(pi: ExtensionAPI, cwd: string, state: RenderingState): void {
  const original = createGrepToolDefinition(cwd);

  const renderCall: GrepRenderCall = (args, theme, context) => {
    if (!state.enabled && original.renderCall)
      return original.renderCall(args, theme, builtinContext(context));
    return frameComponent(context, (width) =>
      frameTop(grepTitle(args, theme), frameStatus(context), theme, width),
    );
  };

  const renderResult: GrepRenderResult = (result, options, theme, context) => {
    if (!state.enabled && original.renderResult)
      return original.renderResult(result, options, theme, builtinContext(context));
    return frameComponent(context, (width) =>
      renderGrepResult(result, options.expanded, theme, context, width),
    );
  };

  pi.registerTool({
    ...original,
    name: "grep",
    renderShell: "self",
    renderCall,
    renderResult,
  });
}

function grepTitle(args: GrepToolInput, theme: GrepTheme): string {
  const path = args.path ? ` ${theme.fg("muted", `in ${args.path}`)}` : "";
  const glob = args.glob ? ` ${theme.fg("muted", `(${args.glob})`)}` : "";
  return `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", args.pattern ?? "")}${path}${glob}`;
}

function renderGrepResult(
  result: AgentToolResult<GrepToolDetails | undefined>,
  expanded: boolean,
  theme: GrepTheme,
  context: Parameters<GrepRenderResult>[3],
  width: number,
): string {
  const status = frameStatus(context);
  if (context.isError) return frameToolError(textFromResult(result), expanded, theme, width);

  const text = normalizeLineEndings(textFromResult(result));
  const lines = text.split("\n").filter(Boolean);
  const matches = lines.filter(isMatchLine);
  const limit = result.details?.matchLimitReached ? " · limit reached" : "";
  const truncated =
    result.details?.truncation?.truncated || result.details?.linesTruncated ? " · truncated" : "";
  if (matches.length === 0)
    return frameResultWithBottomLabel(
      "",
      resultLabel(`0 matches${limit}${truncated}`, expanded, 0, theme),
      status,
      theme,
      width,
    );

  // Three matches across three files use at most eight grouped lines (headings and spacing included).
  // Context and truncation notices remain available when expanded, but cannot grow the preview.
  const shown = expanded ? lines : matches.slice(0, 3);
  const rendered = renderGroupedMatches(
    shown.join("\n"),
    context.args.pattern,
    context.args.literal ?? false,
    context.args.ignoreCase ?? false,
    theme,
  );
  const hidden = expanded ? 0 : lines.length - shown.length;
  const summary = `${matches.length} ${matches.length === 1 ? "match" : "matches"}${limit}${truncated}`;
  return frameResultWithBottomLabel(
    rendered,
    resultLabel(summary, expanded, hidden, theme),
    status,
    theme,
    width,
  );
}

function renderGroupedMatches(
  text: string,
  pattern: string,
  literal: boolean,
  ignoreCase: boolean,
  theme: GrepTheme,
): string {
  const highlight = makeHighlighter(pattern, literal, ignoreCase, theme);
  const output: string[] = [];
  let currentFile = "";

  for (const rawLine of text.split("\n")) {
    if (!rawLine) continue;
    if (rawLine.trim() === "--") {
      output.push(theme.fg("dim", "  ···"));
      continue;
    }

    const match = rawLine.match(/^(.+?)[:-](\d+)[:-](.*)$/);
    if (!match) {
      output.push(rawLine);
      continue;
    }

    const [, file, lineNumber, content] = match;
    if (file !== currentFile) {
      if (currentFile) output.push("");
      output.push(theme.fg("accent", file));
      currentFile = file;
    }

    const lineNumberWidth = Math.max(3, lineNumber.length);
    output.push(
      `  ${theme.fg("dim", lineNumber.padStart(lineNumberWidth, " "))} ${theme.fg("borderMuted", "│")} ${highlight(content)}`,
    );
  }

  return output.join("\n");
}

function isMatchLine(line: string): boolean {
  return /^.+?:\d+:/.test(line);
}

function makeHighlighter(
  pattern: string,
  literal: boolean,
  ignoreCase: boolean,
  theme: GrepTheme,
): (line: string) => string {
  if (!pattern) return (line) => line;
  try {
    const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
    const regex = new RegExp(source, ignoreCase ? "gi" : "g");
    return (line: string) => line.replace(regex, (match) => theme.fg("warning", theme.bold(match)));
  } catch {
    // Unsupported regex syntax should not produce misleading highlighting.
    return (line) => line;
  }
}
