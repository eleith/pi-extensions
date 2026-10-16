/// <reference lib="dom" />
import { parseLinkedomHTML } from "./dom.ts";
import {
  boundedMetadata,
  escapeHtml,
  estimateWordCount,
  limitContent,
  renderJsonContent,
} from "./format.ts";
import type { ContentResult, FetchInput } from "./types.ts";
import { TransportError } from "./transport.ts";

export { inspectHtml } from "./dom.ts";

function isTerminal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: string; code?: string };
  return (
    ["AbortError", "TimeoutError"].includes(value.name ?? "") ||
    ["cancelled", "timeout", "limit", "invalid_request", "unavailable"].includes(value.code ?? "")
  );
}

/** Defuddle may catch fetch failures; remember terminal failures for the caller to rethrow. */
function createControlledExtractorFetch(
  fetcher: typeof globalThis.fetch,
  signal?: AbortSignal,
): { fetch: typeof globalThis.fetch; checkTerminalFailure(): void } {
  let terminalError: unknown;
  const rememberFailure = (error: unknown): never => {
    if (isTerminal(error) || signal?.aborted) terminalError = error;
    throw error;
  };
  const controlledFetch: typeof globalThis.fetch = async (request, init) => {
    signal?.throwIfAborted();
    if (terminalError) throw terminalError;
    const requestSignal =
      typeof request === "object" && "signal" in request ? request.signal : undefined;
    const signals = [signal, init?.signal ?? requestSignal].filter((s): s is AbortSignal => !!s);
    try {
      const response = await fetcher(request, {
        ...init,
        ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
      });
      signal?.throwIfAborted();
      // RequestOwner has already read and bounded the body. Defuddle receives an
      // ordinary buffered Response; its later body methods need no interception.
      return response;
    } catch (error) {
      return rememberFailure(error);
    }
  };
  return {
    fetch: controlledFetch,
    checkTerminalFailure(): void {
      signal?.throwIfAborted();
      if (terminalError) throw terminalError;
    },
  };
}

/** Body decoding, destination validation, deadlines and network budgets belong to the request owner. */
export async function extractContent(
  body: string,
  finalUrl: string,
  input: FetchInput,
  fetcher: typeof globalThis.fetch,
  signal?: AbortSignal,
  contentType?: string,
  statusCode?: number,
): Promise<ContentResult> {
  signal?.throwIfAborted();
  const format = input.format ?? "markdown";
  const mime = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const base: ContentResult = {
    kind: "content",
    url: input.url,
    finalUrl,
    statusCode: statusCode ?? 200,
    contentType: boundedMetadata(mime),
    title: "",
    author: "",
    published: "",
    site: boundedMetadata(new URL(finalUrl).hostname),
    language: "",
    wordCount: 0,
    content: "",
    truncated: false,
    warnings: [],
  };
  const finish = (content: string, warnings: string[] = []): ContentResult => {
    signal?.throwIfAborted();
    const limited = limitContent(content, input.maxChars, format);
    return { ...base, ...limited, warnings: [...warnings, ...limited.warnings] };
  };
  // Deliberately no DOM, redirects, Defuddle, site API calls or invented X status.
  if (format === "raw") return finish(body);

  const declaredJson =
    mime === "application/json" || mime === "text/json" || mime.endsWith("+json");
  const looksJson = /^[\s\uFEFF]*[[{]/.test(body);
  if (declaredJson || looksJson || format === "json") {
    let jsonBody: string | undefined;
    try {
      const source = body.replace(/^\uFEFF/, "");
      JSON.parse(source); // Validate only; reserializing would change numbers, keys and whitespace.
      jsonBody = source;
    } catch {
      if (declaredJson || format === "json")
        throw new TransportError("invalid_json", "Response is not valid JSON.");
      // A brace at the start of plain text is not sufficient evidence of JSON.
    }
    if (jsonBody !== undefined) {
      base.wordCount = estimateWordCount(jsonBody);
      return finish(renderJsonContent(jsonBody, format));
    }
  }

  const html =
    mime === "text/html" ||
    mime === "application/xhtml+xml" ||
    (!mime && /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b|<article\b)/i.test(body));
  if (!html) {
    if (mime && !mime.startsWith("text/"))
      throw new Error("Response is not a readable text or HTML document.");
    base.wordCount = estimateWordCount(body);
    if (["text/markdown", "text/x-markdown"].includes(mime)) {
      // A negotiated Markdown document often has no HTML metadata to preserve.
      // Only its initial H1 qualifies; do not mistake headings inside code examples for a title.
      let leading = body.trimStart();
      // Some documentation servers place machine metadata in leading HTML comments.
      for (let count = 0; count < 3 && leading.startsWith("<!--"); count++) {
        const end = leading.indexOf("-->");
        if (end < 0) break;
        leading = leading.slice(end + 3).trimStart();
      }
      const heading = leading.split(/\r?\n/, 1)[0].match(/^#\s+(.+?)\s*#*$/)?.[1];
      if (heading) base.title = boundedMetadata(heading);
    }
    return finish(format === "html" ? `<pre>${escapeHtml(body)}</pre>` : body);
  }

  const extractionDocument = await parseLinkedomHTML(body, finalUrl);
  // Keep only scalar metadata defaults before Defuddle mutates its working document.
  const documentTitle = extractionDocument.title;
  const documentLanguage = extractionDocument.documentElement.lang;
  const { Defuddle } = await import("defuddle/node");
  signal?.throwIfAborted();
  const extractorFetch = createControlledExtractorFetch(fetcher, signal);
  let extracted: Awaited<ReturnType<typeof Defuddle>>;
  try {
    extracted = await Defuddle(extractionDocument, finalUrl, {
      markdown: format !== "html",
      removeImages: input.removeImages ?? false,
      includeReplies: input.includeReplies ?? "extractors",
      fetch: extractorFetch.fetch,
    });
  } catch (error) {
    extractorFetch.checkTerminalFailure();
    if (isTerminal(error)) throw error;
    // Do not maintain a second extractor or expose arbitrary dependency exceptions.
    throw new Error("Readable content could not be extracted. Retry with format raw.");
  }
  extractorFetch.checkTerminalFailure();

  const content = extracted.content?.trim() ?? "";
  if (!content) throw new Error("Readable content could not be extracted. Retry with format raw.");
  base.title = boundedMetadata(extracted.title || documentTitle);
  base.author = boundedMetadata(extracted.author);
  base.published = boundedMetadata(extracted.published);
  base.site = boundedMetadata(extracted.site) || base.site;
  base.language = boundedMetadata(extracted.language || documentLanguage);
  base.wordCount =
    Number.isFinite(extracted.wordCount) && extracted.wordCount > 0
      ? extracted.wordCount
      : estimateWordCount(content);
  return finish(content);
}
