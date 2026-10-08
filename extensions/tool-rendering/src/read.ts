import type {
  createReadToolDefinition,
  AgentToolResult,
  ReadToolDetails,
  ReadToolInput,
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

type BuiltinReadTool = ReturnType<typeof createReadToolDefinition>;
type ReadRenderCall = NonNullable<BuiltinReadTool["renderCall"]>;
type ReadRenderResult = NonNullable<BuiltinReadTool["renderResult"]>;
type ReadTheme = Parameters<ReadRenderResult>[2];

export function buildReadRendering(): Pick<
  BuiltinReadTool,
  "renderShell" | "renderCall" | "renderResult"
> {
  const renderCall: ReadRenderCall = (args, theme, context) => {
    return frameComponent(context, (width) =>
      frameTop(readTitle(args, theme), frameStatus(context), theme, width),
    );
  };

  const renderResult: ReadRenderResult = (result, options, theme, context) => {
    return frameComponent(context, (width) =>
      renderReadResult(result, options.expanded, theme, context, width),
    );
  };

  return { renderShell: "self", renderCall, renderResult };
}

function readTitle(args: ReadToolInput, theme: ReadTheme): string {
  const offset = args.offset ? ` ${theme.fg("muted", `from ${args.offset}`)}` : "";
  const limit = args.limit ? ` ${theme.fg("muted", `(${args.limit} lines)`)}` : "";
  return `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", args.path ?? "")}${offset}${limit}`;
}

function renderReadResult(
  result: AgentToolResult<ReadToolDetails | undefined>,
  expanded: boolean,
  theme: ReadTheme,
  context: Parameters<ReadRenderResult>[3],
  width: number,
): string {
  const status = frameStatus(context);
  if (context.isError) return frameToolError(textFromResult(result), expanded, theme, width);

  if (result.content.some((item) => item.type === "image")) {
    return frameResultWithBottomLabel(
      "",
      resultLabel("image", expanded, 0, theme),
      status,
      theme,
      width,
    );
  }
  const rawText = normalizeLineEndings(textFromResult(result));
  const text = rawText.replace(/\n$/, "");
  const lines = rawText ? text.split("\n") : [];
  const { shown, hidden } = previewLines(lines, expanded, 10);
  const truncation = result.details?.truncation ? " · truncated" : "";
  const summary = `${lines.length} lines${truncation}`;
  const body = renderNumberedLines(shown, context.args.offset ?? 1, theme);
  return frameResultWithBottomLabel(
    body,
    resultLabel(summary, expanded, hidden, theme),
    status,
    theme,
    width,
  );
}

function renderNumberedLines(lines: string[], offset: number, theme: ReadTheme): string {
  const lastLineNumber = offset + Math.max(0, lines.length - 1);
  const numberWidth = Math.max(3, String(lastLineNumber).length);
  return lines
    .map((line, index) => {
      const lineNumber = String(offset + index).padStart(numberWidth, " ");
      return `${theme.fg("dim", lineNumber)} ${theme.fg("borderMuted", "│")} ${line}`;
    })
    .join("\n");
}
