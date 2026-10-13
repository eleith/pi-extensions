import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  frameComponent,
  frameResultWithBottomLabel,
  frameStatus,
  frameTop,
  resultLabel,
} from "@eleith/pi-internal/frame";
import { LIMITS } from "./core/limits.ts";
import { isRecord } from "./schema.ts";

const PREVIEW_LINES = 4;
const LEGACY_CHARS = 16_000;
const PHASES = new Set(["connecting", "reading", "extracting", "downloading", "done", "error"]);

export function buildFetchRendering(
  name: "web_fetch" | "web_fetch_batch",
): Required<ToolRenderers> {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      return frameComponent(context, (width) => {
        const preview = truncateToWidth(callPreview(args), 50, "…");
        const title = `${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", preview)}`;
        return frameTop(title.trimEnd(), frameStatus(context), theme, width);
      });
    },
    renderResult(result, options, theme, context) {
      return frameComponent(context, (width) => {
        const metadata = readMetadata(result.details);
        const partial = options.isPartial || context.isPartial;
        const legacyError = isRecord(result.details) && result.details.error === true;
        const error =
          context.isError || result.isError === true || metadata?.status === "error" || legacyError;
        const text = resultText(result.content, metadata ? LIMITS.toolOutputChars : LEGACY_CHARS);
        const summary = summaryText(metadata, partial, error);
        let lines: string[];
        if (options.expanded && !partial) {
          // Model-facing output already carries metadata and all available bounded content.
          let expandedText = text;
          if (!expandedText && error) expandedText = "Fetch failed.";
          lines = expandedText.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
        } else {
          lines = collapsedPreview(metadata, result.structuredContent, text);
          if (error && !lines.some((line) => /error|failed|cancelled|deadline/i.test(line)))
            lines.unshift("Fetch failed.");
        }
        const body = lines
          .map((line) =>
            theme.fg(error ? "error" : "toolOutput", truncateToWidth(line, width, "…")),
          )
          .join("\n");
        return frameResultWithBottomLabel(
          body,
          resultLabel(summary, options.expanded, 0, theme),
          error ? "error" : frameStatus({ isPartial: partial }),
          theme,
          width,
        );
      });
    },
  };
}

/** Persisted rows are authoritative; older results fall back to structured data, then text. */
function collapsedPreview(
  metadata: Metadata | undefined,
  structured: unknown,
  text: string,
): string[] {
  let lines: string[];
  if (metadata?.previews !== undefined) lines = metadata.previews;
  else lines = previewLines(structured);
  if (lines.length) return lines;
  if (metadata) return textPreview(text);
  if (text) return text.split("\n").slice(0, PREVIEW_LINES);
  return [];
}

function callPreview(args: unknown): string {
  if (!isRecord(args)) return "";
  if (typeof args.url === "string")
    return clean(args.url.slice(0, LIMITS.maxUrlChars)).replace(/\s+/g, " ");
  if (Array.isArray(args.requests))
    return `${Math.min(args.requests.length, LIMITS.maxRequests)} requests`;
  return "";
}
/** Sanitize untrusted strings before any theme painting. */
function clean(text: string): string {
  return (
    stripTerminalSequences(text)
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
  );
}
function field(value: unknown, limit: number = LIMITS.maxMetadataChars): string {
  return typeof value === "string" ? clean(value.slice(0, limit)).replace(/\s+/g, " ") : "";
}
function resultText(content: unknown, limit: number): string {
  if (!Array.isArray(content)) return "";
  const blocks: string[] = [];
  let remaining = limit;
  for (const block of content.slice(0, 64)) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    blocks.push(block.text.slice(0, remaining));
    remaining -= blocks.at(-1)!.length + 1;
    if (remaining <= 0) break;
  }
  const text = clean(blocks.join("\n"));
  return remaining <= 0 ? `${text}\n[History preview bounded]` : text;
}
/** Pi's TUI currently forwards content/details, not structuredContent, to renderResult. */
function textPreview(text: string): string[] {
  if (!text) return [];
  const sections = text.startsWith("Batch:")
    ? text.replace(/^Batch:[^\n]*\n\n/, "").split("\n\n---\n\n", LIMITS.maxRequests)
    : [text];
  const previews = sections.map((section) => {
    const split = section.indexOf("\n\n");
    const header = (split < 0 ? section : section.slice(0, split)).split("\n");
    const error = header.find((line) => line.startsWith("Error ("));
    const source =
      header.find((line) => line.startsWith("Final source: ")) ??
      header.find((line) => line.startsWith("Source: "));
    if (error) return [error, source ?? ""].filter(Boolean);
    const file = header.find((line) => line.startsWith("File: "));
    if (file)
      return [
        source ?? "",
        header.filter((line) => /^(HTTP:|Bytes:)/.test(line)).join(" · "),
        file,
      ];
    const metadata = header
      .filter((line) => /^(HTTP:|Title:|Truncated: true|Warnings:)/.test(line))
      .join(" · ");
    let body: string[] = [];
    if (split >= 0) {
      body = section
        .slice(split + 2)
        .split("\n")
        .filter((line) => line.trim())
        .slice(0, 2);
    }
    return [source ?? "", metadata, ...body].filter(Boolean);
  });
  if (previews.length === 1) return previews[0].slice(0, PREVIEW_LINES);
  const errors = previews.filter((lines) => lines[0]?.startsWith("Error ("));
  const successes = previews.filter((lines) => !lines[0]?.startsWith("Error ("));
  return [...errors.slice(0, 2), ...successes.slice(0, errors.length ? 2 : 3)].map((lines) =>
    lines.join(" · "),
  );
}
function previewLines(value: unknown): string[] {
  if (!isRecord(value)) return [];
  if (value.kind === "batch" && Array.isArray(value.items)) {
    const items = value.items.slice(0, LIMITS.maxRequests).filter(isRecord);
    // Show ordinary item failures even when an earlier successful item's body is long.
    const errors = items.filter((item) => item.kind === "error");
    const successes = items.filter((item) => item.kind !== "error");
    return [...errors.slice(0, 2), ...successes.slice(0, errors.length ? 2 : 3)].map((item) =>
      itemPreview(item).join(" · "),
    );
  }
  return itemPreview(value).slice(0, PREVIEW_LINES);
}
function itemPreview(item: Record<string, unknown>): string[] {
  const source = field(item.finalUrl ?? item.url, LIMITS.maxUrlChars);
  if (item.kind === "error")
    return [
      `Error (${field(item.code)}): ${field(item.message) || "Fetch failed."}`,
      field(item.url, LIMITS.maxUrlChars),
    ].filter(Boolean);
  const http = typeof item.statusCode === "number" ? `HTTP ${item.statusCode}` : "";
  if (item.kind === "file")
    return [
      source,
      `${http} · file · ${count(item.fileSize, Number.MAX_SAFE_INTEGER)} bytes`,
      `File: ${field(item.filePath, 4096)}`,
    ];
  if (item.kind !== "content") return [];
  const warnings = Array.isArray(item.warnings) ? item.warnings.length : 0;
  const info = [
    http,
    field(item.title),
    item.truncated === true ? "truncated" : "",
    warnings ? `${Math.min(warnings, 8)} warnings` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const body =
    typeof item.content === "string"
      ? clean(item.content.slice(0, 4096))
          .split("\n")
          .filter((line) => line.trim())
          .slice(0, 2)
      : [];
  return [source, info, ...body].filter(Boolean);
}
interface Metadata {
  status: string;
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
  truncated: boolean;
  previews?: string[];
}
function count(value: unknown, max: number = LIMITS.maxRequests): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(0, Math.floor(value)))
    : 0;
}
function readMetadata(value: unknown): Metadata | undefined {
  if (!isRecord(value)) return undefined;
  // Old upstream shapes remain text fallback; never inspect normalized requests, headers or proxies.
  if (
    value.version !== 1 ||
    typeof value.status !== "string" ||
    !PHASES.has(value.status) ||
    typeof value.truncated !== "boolean"
  )
    return undefined;
  let previews: string[] | undefined;
  if (Array.isArray(value.previews) && value.previews.every((row) => typeof row === "string")) {
    previews = value.previews
      .slice(0, PREVIEW_LINES)
      .map((row: string) => clean(row.slice(0, 512)).replace(/\n/g, " "));
  }
  const metadata: Metadata = {
    status: value.status,
    completed: count(value.completed),
    total: count(value.total),
    succeeded: count(value.succeeded),
    failed: count(value.failed),
    truncated: value.truncated,
  };
  if (previews !== undefined) metadata.previews = previews;
  return metadata;
}
function summaryText(metadata: Metadata | undefined, partial: boolean, error: boolean): string {
  let summary = "done";
  if (error) summary = "✗ error";
  else if (partial) {
    summary = "connecting";
    if (metadata && metadata.status !== "done") summary = metadata.status;
  }
  if (metadata) {
    if (partial) summary += ` · ${metadata.completed}/${metadata.total}`;
    else summary += ` · ${metadata.succeeded} succeeded · ${metadata.failed} failed`;
    if (metadata.truncated) summary += " · truncated";
  }
  return summary;
}
