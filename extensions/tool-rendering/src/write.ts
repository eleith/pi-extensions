import type {
  createWriteToolDefinition,
  AgentToolResult,
  WriteToolInput,
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

type BuiltinWriteTool = ReturnType<typeof createWriteToolDefinition>;
type WriteRenderCall = NonNullable<BuiltinWriteTool["renderCall"]>;
type WriteRenderResult = NonNullable<BuiltinWriteTool["renderResult"]>;
type WriteTheme = Parameters<WriteRenderResult>[2];

export function buildWriteRendering(): Pick<
  BuiltinWriteTool,
  "renderShell" | "renderCall" | "renderResult"
> {
  const renderCall: WriteRenderCall = (args, theme, context) => {
    return frameComponent(context, (width) =>
      frameTop(writeTitle(args, theme), frameStatus(context), theme, width),
    );
  };

  const renderResult: WriteRenderResult = (result, options, theme, context) => {
    return frameComponent(context, (width) =>
      renderWriteResult(result, options.expanded, theme, context, width),
    );
  };

  return { renderShell: "self", renderCall, renderResult };
}

function writeTitle(args: WriteToolInput, theme: WriteTheme): string {
  return `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", args.path ?? "")}`;
}

function renderWriteResult(
  result: AgentToolResult,
  expanded: boolean,
  theme: WriteTheme,
  context: Parameters<WriteRenderResult>[3],
  width: number,
): string {
  const status = frameStatus(context);
  if (context.isError) return frameToolError(textFromResult(result), expanded, theme, width);

  const rawContent = normalizeLineEndings(context.args.content);
  const content = rawContent.replace(/\n$/, "");
  const lines = rawContent ? content.split("\n") : [];
  const { shown, hidden } = previewLines(lines, expanded, 10);
  const body = shown
    .map((line, index) => {
      const number = String(index + 1).padStart(3, " ");
      return `${theme.fg("dim", number)} ${theme.fg("borderMuted", "│")} ${line}`;
    })
    .join("\n");
  return frameResultWithBottomLabel(
    body,
    resultLabel(`${lines.length} lines`, expanded, hidden, theme),
    status,
    theme,
    width,
  );
}
