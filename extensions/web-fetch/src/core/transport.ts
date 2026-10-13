import { LIMITS } from "./limits.js";
import type { ErrorCode, FetchHooks, FetchInput } from "./types.js";

export class TransportError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = "TransportError";
  }
}
export interface ByteBudget {
  used: number;
  limit: number;
}
export interface OpenResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}
export type NativeFetch = (
  url: string,
  init: import("wreq-js").RequestInit,
) => Promise<{
  url: string;
  status: number;
  statusText: string;
  headers: Iterable<[string, string]>;
  body: ReadableStream<Uint8Array> | null;
}>;
type TestLimits = { [K in keyof typeof LIMITS]?: number };
type OpenInit = { method?: string; headers?: HeadersInit; body?: string; signal?: AbortSignal };
const ACCEPT = {
  markdown: "text/markdown,text/html;q=0.9,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  json: "application/json,text/plain;q=0.8,*/*;q=0.5",
  html: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
  raw: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
};
const fail = (code: ErrorCode, message: string) => new TransportError(code, message);
function abortError(signal: AbortSignal): TransportError {
  return signal.reason instanceof TransportError
    ? signal.reason
    : fail("cancelled", "Request cancelled.");
}

// Bounds scheduled JS attempts, NOT cancelled native networking or native inline buffers.
let active = 0;
const pending: Array<{ signal: AbortSignal; start: () => void; abort: () => void }> = [];
function admission(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const entry = {
      signal,
      start: () => {
        signal.removeEventListener("abort", entry.abort);
        active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          active--;
          pending.shift()?.start();
        });
      },
      abort: () => {
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
        signal.removeEventListener("abort", entry.abort);
        reject(abortError(signal));
      },
    };
    if (active < LIMITS.networkConcurrency) entry.start();
    else if (pending.length >= LIMITS.maxPending) reject(fail("limit", "Transport queue is full."));
    else {
      pending.push(entry);
      signal.addEventListener("abort", entry.abort, { once: true });
    }
  });
}

// Observe/discard late settlements. Racing is only JS liveness; callers also cancel real bodies.
function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError(signal));
    };
    if (signal.aborted) {
      work.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(abortError(signal));
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(signal.aborted ? abortError(signal) : error);
      },
    );
  });
}
function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  try {
    void body?.cancel().catch(() => {});
  } catch {
    /* best effort */
  }
}
function destination(raw: string, previous?: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail("invalid_request", "Invalid destination URL.");
  }
  if (
    raw.length > LIMITS.maxUrlChars ||
    url.href.length > LIMITS.maxUrlChars ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw fail("invalid_request", "Only HTTP(S) destinations without userinfo are supported.");
  if (previous && new URL(previous).protocol === "https:" && url.protocol === "http:")
    throw fail("invalid_request", "HTTPS downgrade is not allowed.");
  url.hash = "";
  return url;
}
function boundedHeaders(input?: HeadersInit): Headers {
  let headers: Headers;
  try {
    headers = new Headers(input);
  } catch {
    throw fail("invalid_request", "Invalid internal headers.");
  }
  let size = 0,
    count = 0;
  for (const [name, value] of headers) {
    count++;
    size += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (value.length > 8192 || count > 64 || size > 32768)
      throw fail("limit", "Internal headers exceed the limit.");
    if (
      [
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "proxy-authorization",
        "proxy-connection",
      ].includes(name)
    )
      throw fail("invalid_request", "Unsupported internal header.");
  }
  return headers;
}
// Validate internal GET/JSON POST input before admission or native dependency loading.
function prepareInternalRequest(
  raw: string,
  init: OpenInit,
  previous: string | undefined,
  ownerSignal: AbortSignal,
): {
  url: URL;
  method: string;
  body: string | undefined;
  internalHeaders: Headers;
  signal: AbortSignal;
} {
  const url = destination(raw, previous);
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body;
  if (
    !["GET", "POST"].includes(method) ||
    (method === "GET" && body !== undefined) ||
    (body !== undefined && typeof body !== "string")
  ) {
    throw fail("invalid_request", "Only GET and string JSON POST requests are supported.");
  }
  const internalHeaders = boundedHeaders(init.headers);
  if (method === "POST") {
    if (body === undefined || Buffer.byteLength(body) > 65536) {
      throw fail("limit", "Internal request body exceeds the limit.");
    }
    try {
      JSON.parse(body);
    } catch {
      throw fail("invalid_request", "Only JSON POST bodies are supported.");
    }
    if (
      internalHeaders.has("content-type") &&
      !/^application\/json(?:;|$)/i.test(internalHeaders.get("content-type")!)
    ) {
      throw fail("invalid_request", "Only JSON POST bodies are supported.");
    }
  }
  const signal = init.signal ? AbortSignal.any([ownerSignal, init.signal]) : ownerSignal;
  return { url, method, body, internalHeaders, signal };
}
interface BodyState {
  max: number;
  bytes: number;
  signal: AbortSignal;
  cancel: (error?: TransportError) => void;
}

export class RequestOwner {
  readonly signal: AbortSignal;
  readonly fetch: typeof globalThis.fetch;
  readonly limits: { [K in keyof typeof LIMITS]: number };
  private readonly controller = new AbortController();
  private readonly deadlineAt: number;
  private readonly budget?: ByteBudget;
  private readonly nativeFetch?: NativeFetch;
  private readonly hooks: FetchHooks;
  private timer: ReturnType<typeof setTimeout>;
  private detachParent: () => void;
  private readonly bodies = new Map<OpenResponse, BodyState>();
  private readonly visited = new Set<string>();
  private traversalUrl?: string;
  private requests = 0;
  private secondary = 0;
  private accepted = 0;

  constructor(
    private readonly input: FetchInput,
    hooks: FetchHooks = {},
    options: {
      budget?: ByteBudget;
      deadlineAt?: number;
      fetch?: NativeFetch;
      limits?: TestLimits;
    } = {},
  ) {
    this.hooks = hooks;
    this.signal = this.controller.signal;
    this.limits = { ...LIMITS, ...options.limits };
    this.budget = options.budget;
    this.nativeFetch = options.fetch;
    this.deadlineAt =
      options.deadlineAt ?? Date.now() + (input.timeoutMs ?? LIMITS.defaultTimeoutMs);
    const abort = () => this.controller.abort(fail("cancelled", "Request cancelled."));
    hooks.signal?.addEventListener("abort", abort, { once: true });
    this.detachParent = () => hooks.signal?.removeEventListener("abort", abort);
    if (hooks.signal?.aborted) abort();
    this.timer = setTimeout(
      () => this.controller.abort(fail("timeout", "Request deadline exceeded.")),
      Math.max(0, this.deadlineAt - Date.now()),
    );
    this.timer.unref();
    this.fetch = this.extractorFetch.bind(this);
  }

  check(): void {
    if (!this.signal.aborted && Date.now() >= this.deadlineAt)
      this.controller.abort(fail("timeout", "Request deadline exceeded."));
    if (this.signal.aborted) throw abortError(this.signal);
  }

  open(url: string, init: OpenInit = {}): Promise<OpenResponse> {
    return this.openInternal(url, init, false);
  }

  private async openInternal(
    raw: string,
    init: OpenInit,
    secondary: boolean,
  ): Promise<OpenResponse> {
    this.check();
    if (secondary && ++this.secondary > this.limits.maxSecondaryRequests)
      this.exceed("Too many extractor requests.");
    let { url, method, body, internalHeaders, signal } = prepareInternalRequest(
      raw,
      init,
      secondary ? this.input.url : this.traversalUrl,
      this.signal,
    );
    const localVisited = new Set<string>();
    for (;;) {
      this.check();
      if (signal.aborted) throw abortError(signal);
      const visited = secondary ? localVisited : this.visited;
      // A rejected cycle is a failed candidate, not a poisoned request owner: a
      // later alternate or an already-readable original can still be useful.
      if (visited.has(url.href)) throw fail("extraction", "Destination loop detected.");
      if (visited.size >= this.limits.maxHops + 1)
        this.exceed("Destination traversal limit exceeded.");
      visited.add(url.href);
      if (!secondary) this.traversalUrl = url.href;
      if (++this.requests > this.limits.maxRequests) this.exceed("Too many network requests.");
      const headers = new Headers({
        Accept: ACCEPT[this.input.format ?? "markdown"],
        "Accept-Language": "en-US,en;q=0.9",
      });
      for (const [name, value] of internalHeaders) headers.set(name, value);
      if (method === "POST") headers.set("content-type", "application/json");
      const release = await admission(signal);
      let bodyOwnsAdmissionSlot = false;
      try {
        this.check();
        this.hooks.onProgress?.({ phase: "connecting" });
        let fetcher = this.nativeFetch;
        if (!fetcher) {
          try {
            fetcher = (await interrupted(import("wreq-js"), signal)).fetch as NativeFetch;
          } catch {
            if (signal.aborted) throw abortError(signal);
            throw fail(
              "unavailable",
              "Native web transport is unavailable; check wreq-js installation for this host.",
            );
          }
        }
        if (signal.aborted) throw abortError(signal);
        const work = fetcher(url.href, {
          method,
          headers: Array.from(headers),
          body,
          signal,
          redirect: "manual",
          browser: "chrome_147",
          os: "windows",
          timeout: Math.max(1, this.deadlineAt - Date.now()),
        });
        // A native response can arrive after abort; never retain its body or data.
        void work.then(
          (response) => {
            if (signal.aborted) cancelBody(response.body);
          },
          () => {},
        );
        const native = await interrupted(work, signal);
        const responseHeaders = this.validateNativeResponse(native);
        if ([301, 302, 303, 307, 308].includes(native.status) && responseHeaders.has("location")) {
          cancelBody(native.body);
          const next = destination(new URL(responseHeaders.get("location")!, url).href, url.href);
          if (next.origin !== url.origin) {
            internalHeaders = new Headers(); // stays stripped even on return
          }
          if (([301, 302].includes(native.status) && method === "POST") || native.status === 303) {
            method = "GET";
            body = undefined;
            internalHeaders.delete("content-type");
          }
          url = next;
          continue;
        }
        const response: OpenResponse = {
          url: url.href,
          status: native.status,
          statusText: native.statusText,
          headers: responseHeaders,
          body: null,
        };
        // ownBody takes over slot cleanup, releasing immediately if there is no body.
        response.body = this.ownBody(response, native.body, signal, release);
        bodyOwnsAdmissionSlot = true;
        return response;
      } catch (error) {
        if (signal.aborted) throw abortError(signal);
        if (error instanceof TransportError) throw error;
        throw fail("network", "Web request failed.");
      } finally {
        if (!bodyOwnsAdmissionSlot) release();
      }
    }
  }

  // Return bounded parsed headers; every rejection cancels the still-unowned native body.
  private validateNativeResponse(native: Awaited<ReturnType<NativeFetch>>): Headers {
    if (
      !Number.isInteger(native.status) ||
      native.status < 200 ||
      native.status > 599 ||
      native.statusText.length > 512 ||
      /[\r\n]/.test(native.statusText)
    ) {
      cancelBody(native.body);
      throw fail("network", "Invalid response status.");
    }
    let responseHeaders: Headers;
    try {
      responseHeaders = new Headers(Array.from(native.headers));
    } catch {
      cancelBody(native.body);
      throw fail("network", "Invalid response headers.");
    }
    let headerBytes = 0;
    for (const [name, value] of responseHeaders)
      headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (headerBytes > 65536) {
      cancelBody(native.body);
      this.exceed("Response headers exceed the limit.");
    }
    return responseHeaders;
  }

  private exceed(message: string): never {
    const error = fail("limit", message);
    this.controller.abort(error); // extractors may catch errors; check() must still fail
    throw error;
  }

  private ownBody(
    response: OpenResponse,
    source: ReadableStream<Uint8Array> | null,
    signal: AbortSignal,
    release: () => void,
  ): ReadableStream<Uint8Array> | null {
    if (!source) {
      release();
      return null;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let terminal = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const finish = () => {
      if (terminal) return;
      terminal = true;
      signal.removeEventListener("abort", abort);
      this.bodies.delete(response);
      release();
    };
    const cancel = (error?: TransportError) => {
      if (terminal) return;
      // Invoke the actual underlying cancellation, without waiting on native lifetime.
      try {
        const actualReader = reader;
        void (actualReader ? actualReader.cancel(error) : source.cancel(error)).then(
          () => {
            try {
              actualReader?.releaseLock();
            } catch {
              /* native read still pending */
            }
          },
          () => {},
        );
      } catch {
        /* best effort */
      }
      if (error) {
        try {
          controller.error(error);
        } catch {
          /* already closed */
        }
      }
      finish();
    };
    const abort = () => cancel(abortError(signal));
    const state: BodyState = { max: this.limits.textBytes, bytes: 0, signal, cancel };
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (streamController) => {
          controller = streamController;
        },
        pull: async (streamController) => {
          try {
            this.check();
            if (signal.aborted) throw abortError(signal);
            reader ??= source.getReader();
            const result = await interrupted(reader.read(), signal);
            if (terminal || signal.aborted) return;
            if (result.done) {
              streamController.close();
              finish();
              try {
                reader.releaseLock();
              } catch {
                /* pending cancellation */
              }
              return;
            }
            const chunk = result.value;
            // Native decompression/inline buffering precedes these accepted-data counters.
            const bytes = chunk.byteLength;
            if (state.bytes + bytes > state.max)
              this.exceed("Accepted response data exceeds the limit.");
            this.account(bytes);
            state.bytes += bytes;
            streamController.enqueue(chunk);
          } catch (error) {
            cancel(
              error instanceof TransportError
                ? error
                : fail("network", "Response body could not be read."),
            );
          }
        },
        cancel: () => cancel(),
      },
      { highWaterMark: 0 },
    );
    this.bodies.set(response, state);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return stream;
  }

  private account(bytes: number): void {
    if (
      this.accepted + bytes > this.limits.requestBytes ||
      (this.budget && this.budget.used + bytes > this.budget.limit)
    )
      this.exceed("Accepted response data exceeds the limit.");
    this.accepted += bytes;
    if (this.budget) this.budget.used += bytes;
  }

  async read(response: OpenResponse, maxBytes = this.limits.textBytes): Promise<string> {
    this.hooks.onProgress?.({ phase: "reading" });
    maxBytes = Math.min(maxBytes, this.limits.textBytes);
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let decodedBytes = 0,
      rawBytes = 0,
      expansion = 0;
    const append = (text: string) => {
      decodedBytes += Buffer.byteLength(text);
      if (decodedBytes > maxBytes) this.exceed("Decoded text exceeds the limit.");
      // Invalid UTF-8 replacement can expand the accepted decoded text.
      const extra = Math.max(0, decodedBytes - rawBytes - expansion);
      if (extra) {
        this.account(extra);
        expansion += extra;
      }
      chunks.push(text);
    };
    await this.consume(response, maxBytes, (chunk) => {
      rawBytes += chunk.byteLength;
      append(decoder.decode(chunk, { stream: true }));
    });
    append(decoder.decode());
    return chunks.join("");
  }

  // Download uses the same counted stream, with awaited writes/backpressure.
  async consume(
    response: OpenResponse,
    maxBytes: number,
    write: (chunk: Uint8Array) => void | Promise<void>,
  ): Promise<number> {
    this.check();
    if (!response.body) return 0;
    const state = this.bodies.get(response);
    if (!state) throw fail("invalid_request", "Response body is no longer owned.");
    state.max = Math.min(maxBytes, this.limits.downloadBytes);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      reader = response.body.getReader();
      for (;;) {
        this.check();
        const chunk = await interrupted(reader.read(), state.signal);
        if (chunk.done) return state.bytes;
        await write(chunk.value);
        this.check();
        if (state.signal.aborted) throw abortError(state.signal);
      }
    } catch (error) {
      state.cancel(error instanceof TransportError ? error : undefined);
      throw error;
    } finally {
      try {
        reader?.releaseLock();
      } catch {
        /* pending read cancelled */
      }
    }
  }

  cancel(response: OpenResponse): void {
    this.bodies.get(response)?.cancel(fail("cancelled", "Response body discarded."));
  }

  private async extractorFetch(
    resource: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    this.check();
    const allowed = new Set(["method", "headers", "body", "signal", "credentials"]);
    if (init && Object.keys(init).some((key) => !allowed.has(key)))
      throw fail("invalid_request", "Unsupported extractor fetch option.");
    // credentials has no effect: each wreq fetch is ephemeral, with no shared cookie jar.
    if (init?.credentials && !["omit", "same-origin", "include"].includes(init.credentials))
      throw fail("invalid_request", "Unsupported extractor credentials mode.");
    const request = resource instanceof Request ? resource : undefined;
    const signal = init?.signal ?? request?.signal;
    let body = init?.body;
    if (body != null && typeof body !== "string")
      throw fail("invalid_request", "Unsupported extractor body.");
    if (body == null && request?.body) {
      const combined = signal ? AbortSignal.any([this.signal, signal]) : this.signal;
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await interrupted(reader.read(), combined);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 65536) throw fail("limit", "Internal request body exceeds the limit.");
          chunks.push(chunk.value);
        }
        body = Buffer.concat(chunks).toString("utf8");
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* pending read */
        }
      }
    }
    const response = await this.openInternal(
      request?.url ?? String(resource),
      {
        method: init?.method ?? request?.method,
        headers: init?.headers ?? request?.headers,
        body: body == null ? undefined : (body as string),
        signal: signal ?? undefined,
      },
      true,
    );
    const text = await this.read(response);
    let buffered: Response;
    try {
      buffered = new Response([204, 205, 304].includes(response.status) ? null : text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      throw fail("network", "Invalid buffered response.");
    }
    Object.defineProperty(buffered, "url", { value: response.url });
    return buffered;
  }

  async dispose(): Promise<void> {
    clearTimeout(this.timer);
    this.detachParent();
    this.controller.abort(fail("cancelled", "Request disposed."));
    for (const state of this.bodies.values()) state.cancel(fail("cancelled", "Request disposed."));
  }
}
