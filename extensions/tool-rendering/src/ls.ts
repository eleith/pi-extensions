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
import {
  normalizeLineEndings,
  rawTextFromResult,
  sanitizeDisplayText,
  textFromResult,
} from "./tool-result.ts";
import { previewLines } from "./preview.ts";
import { splitListingNotice } from "./listing-output.ts";

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

  const rawText = result.details?.rendering?.text ?? rawTextFromResult(result);
  const normalizedText = normalizeLineEndings(rawText);
  const entryLimit = result.details?.entryLimitReached;
  const truncation = result.details?.truncation;
  const { text: listingText, notice: listingNotice } = splitListingNotice(
    normalizedText,
    "ls",
    entryLimit,
    truncation,
  );
  const text = sanitizeDisplayText(listingText);
  const notice = sanitizeDisplayText(listingNotice);
  const empty =
    text.trim() === "(empty directory)" && entryLimit === undefined && !truncation?.truncated;
  const lines = empty ? [] : text.split("\n").filter((line) => line.trim().length > 0);
  const { shown, hidden } = previewLines(lines, expanded, 10);
  let body = renderEntries(shown, theme);
  if (notice) {
    const warning = theme.fg("warning", notice);
    body = body ? `${body}\n\n${warning}` : warning;
  }
  const limit = entryLimit === undefined ? "" : " · limit reached";
  const truncated = truncation?.truncated ? " · truncated" : "";
  const summary = `${lines.length} entries${limit}${truncated}`;
  const label = resultLabel(summary, expanded, hidden, theme);
  return frameResultWithBottomLabel(body, label, status, theme, width, expanded);
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
