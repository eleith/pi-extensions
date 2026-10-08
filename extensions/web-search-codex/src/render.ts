import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  frameComponent,
  frameResultWithBottomLabel,
  frameStatus,
  frameToolError,
  frameTop,
  resultLabel,
} from "@eleith/pi-internal/frame";

const PREVIEW_LINES = 3;
const QUERY_PREVIEW_COLUMNS = 50;

export function buildSearchRendering(): Required<ToolRenderers> {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      return frameComponent(context, (width) => {
        const query = truncateToWidth(
          queryText(args).replace(/\s+/g, " "),
          QUERY_PREVIEW_COLUMNS,
          "…",
        );
        const title = `${theme.fg("toolTitle", theme.bold("web_search_codex"))} ${theme.fg("accent", query)}`;
        return frameTop(title.trimEnd(), frameStatus(context), theme, width);
      });
    },
    renderResult(result, options, theme, context) {
      return frameComponent(context, (width) => {
        // Persisted sessions and streaming updates may lack current metadata.
        const metadata = readMetadata(result.details);
        const text = resultText(result.content);
        const queryLines = queryBlock(queryText(context.args), theme, width);
        if (context.isError || metadata?.status === "error") {
          const message = options.expanded ? wrapTextWithAnsi(text, width).join("\n") : text;
          return [
            ...queryLines,
            frameToolError(message, options.expanded, theme, width, { showHidden: false }),
          ].join("\n");
        }

        const partial = options.isPartial || context.isPartial;
        const lines = text ? text.replace(/\n$/, "").split("\n") : [];
        // The query stays visible; only the answer preview depends on expansion.
        const showFullAnswer = options.expanded && !partial;
        const shown = showFullAnswer ? lines : lines.slice(0, PREVIEW_LINES);
        const summary = resultSummary(partial, metadata);
        const bodyLines = showFullAnswer
          ? shown.flatMap((line) => wrapTextWithAnsi(line, width))
          : shown;
        return frameResultWithBottomLabel(
          [...queryLines, ...bodyLines.map((line) => theme.fg("toolOutput", line))].join("\n"),
          resultLabel(summary, options.expanded, 0, theme),
          frameStatus({ isPartial: partial }),
          theme,
          width,
        );
      });
    },
  };
}

function queryText(args: unknown): string {
  if (!isRecord(args) || typeof args.query !== "string") return "";
  return cleanText(args.query).trim();
}

function queryBlock(query: string, theme: Theme, width: number): string[] {
  if (!query) return [];
  const wrapped = query.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
  const styled = wrapped.map((line) => theme.fg("accent", truncateToWidth(line, width)));
  return [theme.fg("muted", truncateToWidth("query", width)), ...styled, ""];
}

function resultSummary(partial: boolean, metadata: RenderMetadata | undefined): string {
  let summary = "done";
  if (partial) {
    summary = "searching";
    if (metadata?.status === "answering") summary = "answering";
  }
  if (!metadata) return summary;
  if (metadata.sourceCount === 0) {
    summary += " · no sources";
  } else {
    const label = metadata.sourceCount === 1 ? "source" : "sources";
    summary += ` · ${metadata.sourceCount} ${label}`;
  }
  if (metadata.truncated) summary += " · truncated";
  return summary;
}

/** Sanitize only untrusted text, before applying any of our own theme escapes. */
function cleanText(text: string): string {
  return (
    stripTerminalSequences(text)
      .replace(/\r\n?/g, "\n")
      // The public stripper handles escape sequences; remove remaining raw controls too.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
  );
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== "text" || typeof block.text !== "string") continue;
    texts.push(block.text);
  }
  return cleanText(texts.join("\n"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RenderMetadata {
  status: "searching" | "answering" | "done" | "error";
  sourceCount: number;
  truncated: boolean;
}

function readMetadata(value: unknown): RenderMetadata | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.model !== "string") return undefined;
  if (typeof value.searched !== "boolean" || typeof value.truncated !== "boolean") return undefined;
  switch (value.status) {
    case "searching":
    case "answering":
    case "done":
    case "error":
      break;
    default:
      return undefined;
  }
  if (!Array.isArray(value.sources)) return undefined;
  for (const source of value.sources) {
    if (!isRecord(source)) return undefined;
    if (typeof source.title !== "string" || typeof source.url !== "string") return undefined;
  }
  return { status: value.status, sourceCount: value.sources.length, truncated: value.truncated };
}
