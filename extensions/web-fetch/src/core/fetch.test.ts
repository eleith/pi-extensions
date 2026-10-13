import { describe, expect, it, vi } from "vitest";
import { executeFetch, validateInput } from "./fetch.ts";
import { RequestOwner, TransportError, type OpenResponse } from "./transport.ts";
import type { ContentResult, FetchInput } from "./types.ts";

function content(url: string, body = "Useful article content", wordCount = 100): ContentResult {
  return {
    kind: "content",
    url,
    finalUrl: url,
    statusCode: 200,
    contentType: "text/html",
    title: "Article",
    author: "",
    published: "",
    site: "example.test",
    language: "en",
    wordCount,
    content: body,
    truncated: false,
    warnings: [],
  };
}

function fixture(
  responses: Record<
    string,
    { body: string; status?: number; mime?: string; finalUrl?: string; disposition?: string }
  >,
  signal?: AbortSignal,
) {
  const open = vi.fn(async (url: string): Promise<OpenResponse> => {
    const row = responses[url];
    if (!row) throw new TransportError("network", "Source unavailable.");
    return {
      url: row.finalUrl ?? url,
      status: row.status ?? 200,
      statusText: "",
      headers: new Headers({
        "content-type": row.mime ?? "text/html",
        ...(row.disposition ? { "content-disposition": row.disposition } : {}),
      }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(row.body));
          controller.close();
        },
      }),
    };
  });
  const read = vi.fn(async (response: OpenResponse) => responses[response.url].body);
  const dispose = vi.fn(async () => {});
  const check = vi.fn(() => {
    if (signal?.aborted) throw new TransportError("cancelled", "Request cancelled.");
  });
  const fetcher = vi.fn<typeof fetch>();
  const owner = {
    open,
    read,
    dispose,
    check,
    signal: signal ?? new AbortController().signal,
    fetch: fetcher,
  } as unknown as RequestOwner;
  const createOwner = vi.fn(() => owner);
  const extract = vi.fn(async (body: string, finalUrl: string, input: FetchInput) => ({
    ...content(input.url, body),
    finalUrl,
  }));
  const inspect = vi.fn(async () => ({
    alternates: [] as string[],
    redirect: undefined as string | undefined,
  }));
  return { createOwner, extract, inspect, open, read, dispose, check };
}

describe("fetch request validation", () => {
  it("normalizes defaults without a settings reader", () => {
    expect(validateInput({ url: "https://example.test" })).toEqual({
      url: "https://example.test/",
      format: "markdown",
      maxChars: 50000,
      timeoutMs: 15000,
      removeImages: false,
      includeReplies: "extractors",
    });
  });
  it.each([
    { url: "file:///secret" },
    { url: "https://user:secret@example.test/" },
    { url: "not a URL" },
    { url: "https://example.test", headers: {} },
    { url: "https://example.test", browser: "chrome_145" },
    { url: "https://example.test", proxy: "http://proxy" },
    { url: "https://example.test", verbose: true },
    { url: "https://example.test", maxChars: -1 },
    { url: "https://example.test", maxChars: 100001 },
    { url: "https://example.test", timeoutMs: 0 },
    { url: "https://example.test", timeoutMs: Infinity },
    { url: "https://example.test", format: null },
    { url: "https://example.test", format: "pdf" },
    { url: "https://example.test", removeImages: "yes" },
    { url: "https://example.test", includeReplies: 1 },
    { url: "https://example.test/" + "界".repeat(4000) },
  ])("rejects unsupported or unbounded requests without creating transport", async (input) => {
    const f = fixture({});
    expect(await executeFetch(input as unknown as FetchInput, {}, f)).toMatchObject({
      kind: "error",
      code: "invalid_request",
    });
    expect(f.createOwner).not.toHaveBeenCalled();
  });
  it("allows public/private URLs with no public-address filter", () => {
    expect(validateInput({ url: "http://localhost:3000/" }).url).toBe("http://localhost:3000/");
    expect(validateInput({ url: "http://192.168.1.2/" }).url).toBe("http://192.168.1.2/");
  });
});

it("raw mode bypasses HTML inspection but preserves bounded body results", async () => {
  const url = "https://example.test/";
  const f = fixture({ [url]: { body: '<meta http-equiv="refresh" content="0;url=/other">' } });
  const result = await executeFetch({ url, format: "raw" }, {}, f);
  expect(result).toMatchObject({ kind: "content", url, finalUrl: url });
  expect(f.inspect).not.toHaveBeenCalled();
  expect(f.extract).toHaveBeenCalledWith(
    expect.any(String),
    url,
    expect.objectContaining({ format: "raw" }),
    expect.any(Function),
    expect.any(AbortSignal),
    "text/html",
    200,
  );
  expect(f.dispose).toHaveBeenCalledOnce();
});

it("tries later alternate candidates and keeps original URL provenance", async () => {
  const url = "https://example.test/",
    good = "https://example.test/article.md",
    bad = "https://example.test/bad";
  const f = fixture({
    [url]: { body: "thin shell" },
    [bad]: { body: "error", status: 404 },
    [good]: { body: "actual document", mime: "text/markdown" },
  });
  f.extract.mockImplementation(async (body, finalUrl, input) => ({
    ...content(input.url, body, finalUrl === url ? 2 : 100),
    finalUrl,
  }));
  f.inspect.mockResolvedValue({ alternates: [bad, good], redirect: undefined });
  expect(await executeFetch({ url }, {}, f)).toMatchObject({
    kind: "content",
    url,
    finalUrl: good,
    content: "actual document",
  });
  expect(f.open).toHaveBeenCalledTimes(3);
});

it("retains useful original content after alternate failures and loops", async () => {
  const url = "https://example.test/";
  const f = fixture({ [url]: { body: "short useful page" } });
  f.extract.mockImplementation(async (body, finalUrl, input) => ({
    ...content(input.url, body, 3),
    finalUrl,
  }));
  f.inspect.mockResolvedValue({
    alternates: [url, "https://example.test/missing"],
    redirect: undefined,
  });
  expect(await executeFetch({ url }, {}, f)).toMatchObject({
    kind: "content",
    content: "short useful page",
    warnings: [expect.any(String), expect.any(String)],
  });
  expect(f.open).toHaveBeenCalledTimes(2);
});

it("reports real HTTP status rather than fabricating extraction HTTP failures", async () => {
  const url = "https://example.test/";
  const f = fixture({ [url]: { body: "Forbidden", status: 403 } });
  expect(await executeFetch({ url }, {}, f)).toMatchObject({
    kind: "error",
    code: "http",
    statusCode: 403,
  });
  expect(f.extract).not.toHaveBeenCalled();
  expect(f.dispose).toHaveBeenCalledOnce();
});

it("downloads attachments without buffering or extracting their body", async () => {
  const url = "https://example.test/file";
  const f = fixture({ [url]: { body: "binary", mime: "application/pdf" } });
  const download = vi.fn(async () => ({
    kind: "file" as const,
    url,
    finalUrl: url,
    statusCode: 200,
    contentType: "application/pdf",
    filePath: "/allowed/test.pdf",
    fileSize: 6,
  }));
  expect(await executeFetch({ url }, {}, { ...f, download })).toMatchObject({
    kind: "file",
    fileSize: 6,
  });
  expect(download).toHaveBeenCalledOnce();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.extract).not.toHaveBeenCalled();
});

it("discards extraction results when cancellation arrives during extraction", async () => {
  const url = "https://example.test/",
    controller = new AbortController();
  const f = fixture({ [url]: { body: "article" } }, controller.signal);
  f.extract.mockImplementation(async () => {
    controller.abort();
    return content(url);
  });
  expect(await executeFetch({ url }, { signal: controller.signal }, f)).toMatchObject({
    kind: "error",
    code: "cancelled",
  });
  expect(f.dispose).toHaveBeenCalledOnce();
});

it("does not replace a global input-budget failure with a useful original", async () => {
  const url = "https://example.test/",
    alt = "https://example.test/alt";
  const f = fixture({ [url]: { body: "thin" } });
  f.extract.mockImplementation(async (body) => content(url, body, 1));
  f.inspect.mockResolvedValue({ alternates: [alt], redirect: undefined });
  const open = f.open.getMockImplementation();
  if (!open) throw new Error("Missing fixture transport");
  f.open.mockImplementation(async (target) => {
    if (target === alt) throw new TransportError("limit", "Accepted-byte limit reached.");
    return open(target);
  });
  expect(await executeFetch({ url }, {}, f)).toMatchObject({ kind: "error", code: "limit" });
});

it("still tries a qualified alternate when Defuddle cannot extract the original", async () => {
  const url = "https://example.test/",
    alternate = "https://example.test/document.md";
  const f = fixture({
    [url]: { body: "HTML shell" },
    [alternate]: { body: "Readable Markdown document", mime: "text/markdown" },
  });
  f.inspect.mockResolvedValue({ alternates: [alternate], redirect: undefined });
  f.extract.mockImplementation(async (body, finalUrl, input) => {
    if (finalUrl === url) throw new Error("Extraction failed");
    return { ...content(input.url, body), finalUrl };
  });
  expect(await executeFetch({ url }, {}, f)).toMatchObject({
    kind: "content",
    url,
    finalUrl: alternate,
    content: "Readable Markdown document",
  });
  expect(f.open).toHaveBeenCalledTimes(2);
});
