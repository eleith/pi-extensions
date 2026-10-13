import type { JsonObject } from "@earendil-works/pi-ai";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { LIMITS } from "./core/limits.ts";
import { limitContent } from "./core/format.ts";
import type {
  BatchResult,
  ErrorCode,
  FetchHooks,
  FetchProgress,
  FetchResult,
} from "./core/types.ts";
import { isBatchInput, isFetchInput } from "./schema.ts";

export interface RenderDetails {
  version: 1;
  status: FetchProgress["phase"] | "done" | "error";
  kind?: FetchResult["kind"] | "batch";
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
  truncated: boolean;
  /** Tiny persisted rows; do not infer batch boundaries from untrusted body text. */
  previews?: string[];
}
export type FetchToolResult = AgentToolResult<RenderDetails>;
// Includes JSON escaping, metadata, model text, structuredContent and details (two content copies).
export const TOOL_OUTPUT_CHARS = LIMITS.toolOutputChars;
const messages: Record<ErrorCode, string> = {
  disabled: "Web fetch is disabled. Enable it with the web-fetch command.",
  invalid_request:
    "Invalid fetch request. Use only the documented bounded arguments and an HTTP(S) URL without credentials.",
  cancelled: "Fetch cancelled; native networking cleanup is best-effort.",
  timeout: "Fetch deadline exceeded.",
  limit: "Fetch resource limit exceeded.",
  network: "Network request failed.",
  http: "HTTP request failed.",
  extraction:
    "Readable content could not be extracted. Retry with format raw or browser automation.",
  download: "Download could not be saved.",
  unavailable:
    "Native fetch dependencies are unavailable; check the package installation and supported platform.",
};
function failure(code: ErrorCode, url = ""): FetchResult {
  return { kind: "error", url, code, message: messages[code] };
}

/** Keep disabled/queued execution out of the core, including programmatic calls. */
export function disabledResult(total?: number): FetchToolResult {
  if (total === undefined) return presentResult(failure("disabled"));
  const count = Math.max(1, Math.min(LIMITS.maxRequests, total));
  return presentResult({
    kind: "batch",
    items: Array.from({ length: count }, () => failure("disabled")),
    total: count,
    succeeded: 0,
    failed: count,
    cancelled: false,
    truncated: false,
  });
}

export async function fetchTool(
  input: unknown,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<RenderDetails>,
): Promise<FetchToolResult> {
  if (!isFetchInput(input)) return presentResult(failure("invalid_request"));
  try {
    const { executeFetch } = await import("./core/fetch.ts");
    return presentResult(await executeFetch(input, hooks(signal, onUpdate, 1)));
  } catch {
    // Never echo native exceptions: these can contain internally generated headers/credentials.
    return presentResult(failure(signal?.aborted ? "cancelled" : "unavailable", input.url));
  }
}
export async function batchTool(
  input: unknown,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<RenderDetails>,
): Promise<FetchToolResult> {
  if (!isBatchInput(input))
    return presentResult({
      kind: "batch",
      items: [failure("invalid_request")],
      total: 1,
      succeeded: 0,
      failed: 1,
      cancelled: false,
      truncated: false,
    });
  try {
    const { executeBatch } = await import("./core/batch.ts");
    return presentResult(
      await executeBatch(input.requests, hooks(signal, onUpdate, input.requests.length)),
    );
  } catch {
    return presentResult({
      kind: "batch",
      items: input.requests.map((request) =>
        failure(signal?.aborted ? "cancelled" : "unavailable", request.url),
      ),
      total: input.requests.length,
      succeeded: 0,
      failed: input.requests.length,
      cancelled: signal?.aborted ?? false,
      truncated: false,
    });
  }
}
function hooks(
  signal: AbortSignal | undefined,
  update: AgentToolUpdateCallback<RenderDetails> | undefined,
  total: number,
): FetchHooks {
  return {
    signal,
    onProgress(progress) {
      update?.({
        content: [],
        details: {
          version: 1,
          status: progress.phase,
          completed: Math.min(total, Math.max(0, progress.completed ?? 0)),
          total,
          succeeded: 0,
          failed: 0,
          truncated: false,
        },
      });
    },
  };
}

/** Rebuild an allowlisted result, never copying normalized requests or private transport fields. */
function boundedItem(item: FetchResult): FetchResult {
  // Canonical source strings and normal metadata retain their meaning regardless
  // of batch length; content is the first thing reduced by the shared budget.
  const sourceLimit = LIMITS.maxUrlChars;
  const metaLimit = LIMITS.maxMetadataChars;
  const url = item.url.slice(0, sourceLimit);
  if (item.kind === "error")
    return {
      kind: "error",
      url,
      code: item.code,
      message: messages[item.code],
      ...(item.statusCode === undefined ? {} : { statusCode: item.statusCode }),
    };
  const source = {
    url,
    finalUrl: item.finalUrl.slice(0, sourceLimit),
    statusCode: item.statusCode,
    contentType: bound(item.contentType, metaLimit),
  };
  if (item.kind === "file")
    return {
      kind: "file",
      ...source,
      filePath: item.filePath.slice(0, LIMITS.maxFilePathChars),
      fileSize: item.fileSize,
    };
  const metadata = {
    title: bound(item.title, metaLimit),
    author: bound(item.author, metaLimit),
    published: bound(item.published, metaLimit),
    site: bound(item.site, metaLimit),
    language: bound(item.language, metaLimit),
  };
  const warnings = item.warnings.slice(0, 4).map((warning) => bound(warning, metaLimit));
  const shortened =
    source.url !== item.url ||
    source.finalUrl !== item.finalUrl ||
    source.contentType !== item.contentType ||
    Object.entries(metadata).some(([key, value]) => value !== item[key as keyof typeof metadata]) ||
    item.warnings.length > 4 ||
    warnings.some((warning, index) => warning !== item.warnings[index]);
  if (shortened) warnings.push("Tool metadata shortened.");
  const content = item.content.slice(0, LIMITS.maxChars);
  return {
    kind: "content",
    ...source,
    ...metadata,
    wordCount: item.wordCount,
    content,
    warnings,
    truncated: item.truncated || content.length < item.content.length,
  };
}
// Bound encoded size as well as characters; hostile metadata must not inflate JSON serialization.
function bound(text: string, limit: number): string {
  const prefix = text.slice(0, limit);
  if (text.length <= limit && JSON.stringify(prefix).length <= limit + 2) return prefix;
  let low = 0,
    high = prefix.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(prefix.slice(0, mid)).length <= limit - 1) low = mid;
    else high = mid - 1;
  }
  return `${prefix.slice(0, low)}…`;
}

export function presentResult(outcome: FetchResult | BatchResult): FetchToolResult {
  const isBatch = outcome.kind === "batch";
  let originalItems: FetchResult[];
  if (isBatch) originalItems = outcome.items;
  else originalItems = [outcome];
  const items = originalItems.slice(0, LIMITS.maxRequests).map(boundedItem);

  // First allocate body characters in input order. Then measure the complete,
  // serialized result, including text/structured copies and presentation metadata.
  allocateContentBudget(items, isBatch ? LIMITS.batchChars : LIMITS.maxChars);
  const full = buildToolResult(outcome, retainContent(items, 1), false);
  if (fitsOutputBudget(full)) return full;

  // Keep usable paths in structured data; only compact their model-facing preview
  // if metadata alone exceeds the serialized budget.
  const compactFilePreviews = !fitsOutputBudget(
    buildToolResult(outcome, retainContent(items, 0), false),
  );
  const build = (ratio: number) =>
    buildToolResult(outcome, retainContent(items, ratio), compactFilePreviews);
  let low = 0,
    high = 1;
  for (let attempt = 0; attempt < 24; attempt++) {
    const ratio = (low + high) / 2;
    if (fitsOutputBudget(build(ratio))) low = ratio;
    else high = ratio;
  }
  return build(low);
}

/** Mutates only the allowlisted copies produced by boundedItem, never caller outcomes. */
function allocateContentBudget(items: FetchResult[], remaining: number): void {
  for (const item of items) {
    if (item.kind !== "content") continue;
    if (item.content.length > remaining) {
      item.content = limitContent(item.content, remaining, "raw").content;
      item.truncated = true;
      item.warnings.push("Tool content budget reached.");
    }
    remaining -= item.content.length;
  }
}

/** Preserve the same fraction of each already-allocated item when serialization needs more room. */
function retainContent(items: FetchResult[], ratio: number): FetchResult[] {
  return items.map((item): FetchResult => {
    if (item.kind !== "content") return item;
    const content = limitContent(
      item.content,
      Math.floor(item.content.length * ratio),
      "raw",
    ).content;
    const shortened = content.length < item.content.length;
    let warnings = item.warnings;
    if (shortened) warnings = [...warnings, "Tool output budget truncated content."];
    return { ...item, content, truncated: item.truncated || shortened, warnings };
  });
}

function fitsOutputBudget(result: FetchToolResult): boolean {
  return JSON.stringify(result).length <= TOOL_OUTPUT_CHARS;
}

function buildToolResult(
  outcome: FetchResult | BatchResult,
  items: FetchResult[],
  compactFilePreviews: boolean,
): FetchToolResult {
  const isBatch = outcome.kind === "batch";
  const total = items.length;
  const succeeded = items.filter((item) => item.kind !== "error").length;
  const failed = total - succeeded;
  const cancelled = isBatch && outcome.cancelled;
  const truncated =
    compactFilePreviews ||
    (isBatch && outcome.truncated) ||
    items.some((item) => item.kind === "content" && item.truncated);
  const isError = cancelled || succeeded === 0;
  let structuredContent: JsonObject;
  let summary = "";
  if (isBatch) {
    structuredContent = {
      kind: "batch",
      items: items.map(jsonItem),
      total,
      succeeded,
      failed,
      cancelled,
      truncated,
    };
    summary = `Batch: ${total} total · ${succeeded} succeeded · ${failed} failed`;
    if (cancelled) summary += " · cancelled";
    if (truncated) summary += " · truncated";
    summary += "\n\n";
  } else structuredContent = jsonItem(items[0]);
  let status: RenderDetails["status"] = "done";
  if (isError) status = "error";
  const details: RenderDetails = {
    version: 1,
    status,
    kind: outcome.kind,
    completed: total,
    total,
    succeeded,
    failed,
    truncated,
    previews: previewRows(items),
  };
  return {
    content: [
      {
        type: "text",
        text:
          summary + items.map((item) => itemText(item, compactFilePreviews)).join("\n\n---\n\n"),
      },
    ],
    structuredContent,
    details,
    isError,
  };
}
function previewRows(items: FetchResult[]): string[] {
  const failures = items.filter((item) => item.kind === "error");
  const successes = items.filter((item) => item.kind !== "error");
  let rows: string[];
  if (items.length > 1) {
    const selected = [...failures.slice(0, 2), ...successes.slice(0, failures.length ? 2 : 3)];
    rows = selected.map(batchPreviewRow);
  } else rows = items.flatMap(singlePreviewRows);
  return rows.slice(0, 4).map((row) => bound(row, 512));
}

function batchPreviewRow(item: FetchResult): string {
  if (item.kind === "error") return `Error (${item.code}): ${item.message} · ${item.url}`;
  if (item.kind === "file")
    return `file · ${item.fileSize} bytes · File: ${item.filePath} · ${item.finalUrl}`;
  const title = item.title || `HTTP ${item.statusCode}`;
  let row = `${item.finalUrl} · ${title}`;
  if (item.truncated) row += " · truncated";
  return row;
}

function singlePreviewRows(item: FetchResult): string[] {
  if (item.kind === "error") return [`Error (${item.code}): ${item.message}`, item.url];
  if (item.kind === "file")
    return [
      item.finalUrl,
      `HTTP ${item.statusCode} · file · ${item.fileSize} bytes`,
      `File: ${item.filePath}`,
    ];
  const snippet = item.content
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, 2);
  let summary = `HTTP ${item.statusCode}`;
  if (item.title) summary += ` · ${item.title}`;
  if (item.truncated) summary += " · truncated";
  if (item.warnings.length) summary += ` · ${item.warnings.length} warnings`;
  return [item.finalUrl, summary, ...snippet];
}

function jsonItem(item: FetchResult): JsonObject {
  return { ...item };
}
function itemText(item: FetchResult, compactFiles = false): string {
  if (item.kind === "error")
    return `Source: ${item.url}\nError (${item.code})${item.statusCode === undefined ? "" : ` · HTTP ${item.statusCode}`}: ${item.message}`;
  const source = `Source: ${item.url}\nFinal source: ${item.finalUrl}\nHTTP: ${item.statusCode} · ${item.contentType}`;
  if (item.kind === "file") {
    const path = compactFiles ? bound(item.filePath, 1024) : item.filePath;
    let notice = "";
    if (path !== item.filePath)
      notice = "\nWarning: file path preview shortened; full bounded path is in structuredContent.";
    else if (item.filePath.endsWith("…")) notice = "\nWarning: file path metadata shortened.";
    return `${source}\nFile: ${path}\nBytes: ${item.fileSize}${notice}`;
  }
  const metadata = [
    ["Title", item.title],
    ["Author", item.author],
    ["Published", item.published],
    ["Site", item.site],
    ["Language", item.language],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
  return `${source}${metadata ? `\n${metadata}` : ""}\nWords: ${item.wordCount}\nTruncated: ${item.truncated}${item.warnings.length ? `\nWarnings: ${item.warnings.join("; ")}` : ""}\n\n${item.content}`;
}
