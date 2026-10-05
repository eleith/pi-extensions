import {
  createFindToolDefinition,
  type AgentToolResult,
  type ExtensionAPI,
  type FindToolDetails,
  type FindToolInput,
} from "@earendil-works/pi-coding-agent";
import { basename, dirname } from "node:path";
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
import { previewLines } from "./preview.ts";
import type { RenderingState } from "./state.ts";

type BuiltinFindTool = ReturnType<typeof createFindToolDefinition>;
type FindRenderCall = NonNullable<BuiltinFindTool["renderCall"]>;
type FindRenderResult = NonNullable<BuiltinFindTool["renderResult"]>;
type FindTheme = Parameters<FindRenderResult>[2];

interface FindDisplayDetails extends FindToolDetails {
  readonly rendering?: {
    readonly text: string;
  };
}

export function registerFindRendering(pi: ExtensionAPI, cwd: string, state: RenderingState): void {
  const original = createFindToolDefinition(cwd);

  const renderCall: FindRenderCall = (args, theme, context) => {
    if (!state.enabled && original.renderCall)
      return original.renderCall(args, theme, builtinContext(context));
    return frameComponent(context, (width) =>
      frameTop(findTitle(args, theme), frameStatus(context), theme, width),
    );
  };

  const renderResult: FindRenderResult = (result, options, theme, context) => {
    if (!state.enabled && original.renderResult)
      return original.renderResult(result, options, theme, builtinContext(context));
    return frameComponent(context, (width) =>
      renderFindResult(result, options.expanded, theme, context, width),
    );
  };

  pi.registerTool({
    ...original,
    name: "find",
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = (await original.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      )) as AgentToolResult<FindDisplayDetails>;
      result.details = {
        ...result.details,
        rendering: {
          text: normalizeLineEndings(textFromResult(result)),
        },
      };
      return result;
    },
    renderCall,
    renderResult,
  });
}

function findTitle(args: FindToolInput, theme: FindTheme): string {
  const path = args.path ? ` ${theme.fg("muted", `in ${args.path}`)}` : "";
  const limit = args.limit ? ` ${theme.fg("muted", `(${args.limit} files)`)}` : "";
  return `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", args.pattern ?? "")}${path}${limit}`;
}

function renderFindResult(
  result: AgentToolResult<FindDisplayDetails | undefined>,
  expanded: boolean,
  theme: FindTheme,
  context: Parameters<FindRenderResult>[3],
  width: number,
): string {
  const status = frameStatus(context);
  if (context.isError) return frameToolError(textFromResult(result), expanded, theme, width);

  const text = result.details?.rendering?.text ?? textFromResult(result);
  const paths =
    text.trim() === "No files found matching pattern"
      ? []
      : text.split("\n").filter((line) => line.trim().length > 0);
  // Three paths in separate directories use at most eight grouped lines.
  const { shown, hidden } = previewLines(paths, expanded, 3);
  const body = renderGroupedPaths(shown, theme);
  const limit = result.details?.resultLimitReached ? " · limit reached" : "";
  return frameResultWithBottomLabel(
    body,
    resultLabel(`${paths.length} files${limit}`, expanded, hidden, theme),
    status,
    theme,
    width,
  );
}

function renderGroupedPaths(paths: string[], theme: FindTheme): string {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const dir = dirname(path) || ".";
    const file = basename(path);
    const existing = groups.get(dir);
    if (existing) existing.push(file);
    else groups.set(dir, [file]);
  }

  const output: string[] = [];
  for (const [dir, files] of groups) {
    if (output.length > 0) output.push("");
    output.push(theme.fg("accent", `${dir}/`));
    files.forEach((file, index) => {
      const marker = index === files.length - 1 ? "└──" : "├──";
      output.push(`  ${theme.fg("borderMuted", marker)} ${file}`);
    });
  }
  return output.join("\n");
}
