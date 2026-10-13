import { LIMITS } from "./limits.ts";
import { type FetchHooks, type FetchInput, type FetchResult, type ContentResult } from "./types.ts";
import { RequestOwner, TransportError, type ByteBudget, type OpenResponse } from "./transport.ts";
import { extractContent, inspectHtml } from "./extract.ts";
import { downloadResponse } from "./download.ts";
import { checkFetchInput } from "./input.ts";

/** Execution keeps actionable errors; the shared validator itself never imports transport. */
export function validateInput(value: unknown): Required<FetchInput> {
  const checked = checkFetchInput(value);
  if (typeof checked === "string") throw new TransportError("invalid_request", checked);
  return checked;
}

export interface FetchDependencies {
  createOwner?: (
    input: FetchInput,
    hooks: FetchHooks,
    options: { budget?: ByteBudget; deadlineAt?: number },
  ) => RequestOwner;
  extract?: typeof extractContent;
  inspect?: typeof inspectHtml;
  download?: typeof downloadResponse;
  budget?: ByteBudget;
  deadlineAt?: number;
}

export function failure(input: unknown, error: unknown): FetchResult {
  let url =
    input && typeof input === "object" && "url" in input && typeof input.url === "string"
      ? input.url.slice(0, LIMITS.maxUrlChars)
      : "";
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) url = "";
  } catch {
    // A bounded invalid source identifier is useful, but embedded credentials are not.
  }
  if (error instanceof TransportError)
    return {
      kind: "error",
      url,
      code: error.code,
      message: error.message.slice(0, LIMITS.maxMetadataChars),
      ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
    };
  // Do not echo arbitrary extractor/native exception strings or request options.
  return {
    kind: "error",
    url,
    code: "extraction",
    message:
      "No usable content was returned. Retry with format raw, or use browser automation if the page requires JavaScript or authentication.",
  };
}

/** Bound async extraction liveness; late work is observed/discarded, not forcibly terminated. */
function awaitOwned<T>(work: Promise<T>, owner: RequestOwner): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => owner.signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      try {
        owner.check();
      } catch (error) {
        reject(error);
        return;
      }
      reject(new TransportError("cancelled", "Request cancelled."));
    };
    if (owner.signal.aborted) {
      work.catch(() => {});
      abort();
      return;
    }
    owner.signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        cleanup();
        try {
          owner.check();
          resolve(value);
        } catch (error) {
          reject(error);
        }
      },
      (error) => {
        cleanup();
        try {
          owner.check();
        } catch (cancelled) {
          reject(cancelled);
          return;
        }
        reject(error);
      },
    );
  });
}

function classifyResponse(response: OpenResponse) {
  const contentType = response.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0].trim().toLowerCase();
  return {
    contentType,
    isAttachment: /^attachment(?:;|$)/i.test(response.headers.get("content-disposition") ?? ""),
    isReadableContentType:
      mime.startsWith("text/") ||
      mime === "application/xhtml+xml" ||
      mime === "application/json" ||
      mime.endsWith("+json"),
    isHtml: mime === "text/html" || mime === "application/xhtml+xml",
    hasNoBody: response.status === 204 || response.status === 205,
  };
}

/** Refresh redirects apply even to a useful original; alternates only recover thin content. */
function sourceCandidates(
  hints: { redirect?: string; alternates: string[] },
  original?: ContentResult,
): string[] {
  const candidates: string[] = [];
  if (hints.redirect) candidates.push(hints.redirect);
  if (!original || original.wordCount < 20) candidates.push(...hints.alternates);
  return candidates.slice(0, 4);
}

function throwIfRecoveryMustStop(error: unknown, owner: RequestOwner): void {
  owner.check();
  if (error instanceof TransportError && ["cancelled", "timeout", "limit"].includes(error.code))
    throw error;
}

export async function executeFetch(
  input: FetchInput,
  hooks: FetchHooks = {},
  dependencies: FetchDependencies = {},
): Promise<FetchResult> {
  let owner: RequestOwner | undefined;
  try {
    const request = validateInput(input);
    const ownerOptions = { budget: dependencies.budget, deadlineAt: dependencies.deadlineAt };
    if (dependencies.createOwner) owner = dependencies.createOwner(request, hooks, ownerOptions);
    else owner = new RequestOwner(request, hooks, ownerOptions);
    const context = owner;
    const visited = new Set<string>();
    let attempts = 0;
    const loadSource = async (target: string, allowDownload = true): Promise<FetchResult> => {
      context.check();
      if (++attempts > LIMITS.maxHops)
        throw new TransportError("limit", "Source traversal limit reached.");
      const key = new URL(target).href;
      if (visited.has(key))
        throw new TransportError("extraction", "Source redirect or alternate loop detected.");
      visited.add(key);
      const response = await context.open(key);
      if (response.url !== key) {
        if (visited.has(response.url)) {
          await response.body?.cancel();
          throw new TransportError("extraction", "Source redirect loop detected.");
        }
        visited.add(response.url);
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw new TransportError(
          "http",
          `Server returned HTTP ${response.status}.`,
          response.status,
        );
      }
      const responseType = classifyResponse(response);
      const isBinaryResponse = !responseType.isReadableContentType && !responseType.hasNoBody;
      if ((responseType.isAttachment && allowDownload) || isBinaryResponse) {
        if (!allowDownload) {
          await response.body?.cancel();
          throw new TransportError("extraction", "Alternate source is not readable content.");
        }
        hooks.onProgress?.({ phase: "downloading" });
        return (dependencies.download ?? downloadResponse)(context, response, request.url);
      }
      hooks.onProgress?.({ phase: "reading" });
      const body = await context.read(response, LIMITS.textBytes);
      context.check();
      let sources: Awaited<ReturnType<typeof inspectHtml>> = { alternates: [] };
      if (responseType.isHtml && request.format !== "raw") {
        sources = await awaitOwned(
          (dependencies.inspect ?? inspectHtml)(body, response.url, request.format),
          context,
        );
      }
      let original: ContentResult | undefined;
      try {
        if (request.format !== "raw") hooks.onProgress?.({ phase: "extracting" });
        original = await awaitOwned(
          (dependencies.extract ?? extractContent)(
            body,
            response.url,
            request,
            context.fetch,
            context.signal,
            responseType.contentType,
            response.status,
          ),
          context,
        );
        context.check();
      } catch (error) {
        throwIfRecoveryMustStop(error, context);
      }
      for (const source of sourceCandidates(sources, original)) {
        try {
          // Only refresh redirects can select a download; content alternates cannot leave files behind.
          const alternate = await loadSource(source, allowDownload && sources.redirect === source);
          if (alternate.kind === "file" && sources.redirect === source) return alternate;
          if (alternate.kind === "content" && alternate.wordCount > 0) return alternate;
        } catch (error) {
          throwIfRecoveryMustStop(error, context);
        }
        if (original && original.warnings.length < 3)
          original.warnings.push(
            "A redirect or alternate source was unavailable; retained readable original content.",
          );
      }
      if (!original || (!original.content.trim() && request.format !== "raw"))
        throw new TransportError(
          "extraction",
          "No readable content was extracted. Retry with format raw or browser automation.",
        );
      return original;
    };
    const result = await loadSource(request.url);
    context.check();
    return result;
  } catch (error) {
    return failure(input, error);
  } finally {
    await owner?.dispose();
  }
}
