import type {
  createLsToolDefinition,
  AgentToolResult,
  LsToolDetails,
  LsToolInput,
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

type BuiltinLsTool = ReturnType<typeof createLsToolDefinition>;
type LsRenderCall = NonNullable<BuiltinLsTool["renderCall"]>;
type LsRenderResult = NonNullable<BuiltinLsTool["renderResult"]>;
type LsTheme = Parameters<LsRenderResult>[2];

interface LsDisplayDetails extends LsToolDetails {
  readonly rendering?: {
    readonly text: string;
  };
}

export function buildLsRendering(): Pick<
  BuiltinLsTool,
  "renderShell" | "renderCall" | "renderResult"
> {
  const renderCall: LsRenderCall = (args, theme, context) => {
    return frameComponent(context, (width) =>
      frameTop(lsTitle(args, theme), frameStatus(context), theme, width),
    );
  };

  const renderResult: LsRenderResult = (result, options, theme, context) => {
    return frameComponent(context, (width) =>
      renderLsResult(result, options.expanded, theme, context, width),
    );
  };

  return { renderShell: "self", renderCall, renderResult };
}

function lsTitle(args: LsToolInput, theme: LsTheme): string {
  const limit = args.limit ? ` ${theme.fg("muted", `(${args.limit} entries)`)}` : "";
  return `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", args.path ?? ".")}${limit}`;
}

function renderLsResult(
  result: AgentToolResult<LsDisplayDetails | undefined>,
  expanded: boolean,
  theme: LsTheme,
  context: Parameters<LsRenderResult>[3],
  width: number,
): string {
  const status = frameStatus(context);
  if (context.isError) return frameToolError(textFromResult(result), expanded, theme, width);

  const text = normalizeLineEndings(result.details?.rendering?.text ?? textFromResult(result));
  const lines =
    text.trim() === "(empty directory)"
      ? []
      : text.split("\n").filter((line) => line.trim().length > 0);
  const { shown, hidden } = previewLines(lines, expanded, 10);
  const body = renderEntries(shown, theme);
  const limit = result.details?.entryLimitReached ? " · limit reached" : "";
  return frameResultWithBottomLabel(
    body,
    resultLabel(`${lines.length} entries${limit}`, expanded, hidden, theme),
    status,
    theme,
    width,
  );
}

function renderEntries(lines: string[], theme: LsTheme): string {
  return lines
    .map((line, index) => {
      const isLast = index === lines.length - 1;
      const marker = isLast ? "└──" : "├──";
      return `${theme.fg("borderMuted", marker)} ${line.trim()}`;
    })
    .join("\n");
}
