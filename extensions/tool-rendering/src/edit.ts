import type {
  createEditToolDefinition,
  AgentToolResult,
  EditToolDetails,
  EditToolInput,
} from "@earendil-works/pi-coding-agent";
import {
  frameComponent,
  frameResultWithBottomLabel,
  frameStatus,
  frameToolError,
  frameTop,
  resultLabel,
} from "./frame.ts";
import { normalizeLineEndings, textFromResult } from "./tool-result.ts";
import { previewLines } from "./preview.ts";

type BuiltinEditTool = ReturnType<typeof createEditToolDefinition>;
type EditRenderCall = NonNullable<BuiltinEditTool["renderCall"]>;
type EditRenderResult = NonNullable<BuiltinEditTool["renderResult"]>;
type EditTheme = Parameters<EditRenderResult>[2];

export function buildEditRendering(): Pick<
  BuiltinEditTool,
  "renderShell" | "renderCall" | "renderResult"
> {
  const renderCall: EditRenderCall = (args, theme, context) => {
    return frameComponent(context, (width) =>
      frameTop(editTitle(args, theme), frameStatus(context), theme, width),
    );
  };

  const renderResult: EditRenderResult = (result, options, theme, context) => {
    return frameComponent(context, (width) =>
      renderEditResult(result, options.expanded, theme, context, width),
    );
  };

  return { renderShell: "self", renderCall, renderResult };
}

function editTitle(args: EditToolInput, theme: EditTheme): string {
  return `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", args.path ?? "")} ${theme.fg("muted", `(${args.edits?.length ?? 0} edits)`)}`;
}

function renderEditResult(
  result: AgentToolResult<EditToolDetails | undefined>,
  expanded: boolean,
  theme: EditTheme,
  context: Parameters<EditRenderResult>[3],
  width: number,
): string {
  const status = frameStatus(context);
  if (context.isError) return frameToolError(textFromResult(result), expanded, theme, width);

  const diff = normalizeLineEndings(
    result.details?.diff || result.details?.patch || textFromResult(result),
  );
  const stats = diffStats(diff);
  const label = `+${stats.added} -${stats.removed}`;
  const lines = diff
    .replace(/\n$/, "")
    .split("\n")
    .filter((line) => line && !line.startsWith("***"));
  const { shown, hidden } = previewLines(lines, expanded, 8);
  return frameResultWithBottomLabel(
    renderDiff(shown, theme),
    resultLabel(label, expanded, hidden, theme),
    status,
    theme,
    width,
  );
}

function renderDiff(lines: string[], theme: EditTheme): string {
  return lines
    .map((line) => {
      if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
      if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
      if (line.startsWith("@@")) return theme.fg("muted", line);
      return theme.fg("toolDiffContext", line);
    })
    .join("\n");
}

function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added++;
    if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}
