import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { presentResult, TOOL_OUTPUT_CHARS } from "./tool.ts";
import { buildFetchRendering } from "./render.ts";
import { isBatchInput } from "./schema.ts";
import { executeBatch } from "./core/batch.ts";
import { RequestOwner } from "./core/transport.ts";
import { executeFetch } from "./core/fetch.ts";
import type { ContentResult, FetchResult } from "./core/types.ts";

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
const context = (): RenderContext => ({
  args: {},
  toolCallId: "probe",
  invalidate() {},
  lastComponent: undefined,
  state: {},
  cwd: "/workspace",
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  expanded: false,
  showImages: false,
  isError: false,
  durationMs: undefined,
  outputPad: 0,
});
function content(url: string, text = "Small readable content"): ContentResult {
  return {
    kind: "content",
    url,
    finalUrl: url,
    statusCode: 200,
    contentType: "text/plain",
    title: "Title ".repeat(30),
    author: "",
    published: "",
    site: "example.test",
    language: "en",
    wordCount: 3,
    content: text,
    truncated: false,
    warnings: [],
  };
}

it.each(["content", "file", "error"] as const)(
  "preserves ordinary long canonical %s source URLs in a 24-item batch",
  (kind) => {
    const urls = Array.from(
      { length: 24 },
      (_, i) => `https://example.test/${i}?query=${"x".repeat(450)}`,
    );
    const items: FetchResult[] = urls.map((url) =>
      kind === "content"
        ? content(url)
        : kind === "file"
          ? {
              kind,
              url,
              finalUrl: url,
              statusCode: 200,
              contentType: "application/pdf",
              filePath: "/workspace/private/file.pdf",
              fileSize: 1,
            }
          : { kind, url, code: "network", message: "Source unavailable." },
    );
    const result = presentResult({
      kind: "batch",
      items,
      total: 24,
      succeeded: kind === "error" ? 0 : 24,
      failed: kind === "error" ? 24 : 0,
      cancelled: false,
      truncated: false,
    });
    const structured = result.structuredContent as unknown as { items: FetchResult[] };
    expect(structured.items.map((item) => item.url)).toEqual(urls);
    for (const item of structured.items) {
      if (item.kind !== "error") expect(item.finalUrl).toBe(item.url);
      if (item.kind === "content") expect(item.title).toBe("Title ".repeat(30));
    }
    expect(JSON.stringify(result).length).toBeLessThan(100_000);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_OUTPUT_CHARS);
  },
);

it("keeps a later batch failure visible even when an article has many horizontal rules/fences", () => {
  const article = content(
    "https://example.test/article",
    Array.from({ length: 30 }, () => "Paragraph\n\n---\n\n```text\n---\n```").join("\n"),
  );
  const result = presentResult({
    kind: "batch",
    items: [
      article,
      {
        kind: "error",
        url: "https://example.test/failure",
        code: "http",
        statusCode: 403,
        message: "Forbidden",
      },
    ],
    total: 2,
    succeeded: 1,
    failed: 1,
    cancelled: false,
    truncated: false,
  });
  const renderer = buildFetchRendering("web_fetch_batch");
  // Pi's actual history/TUI pipeline does not include structuredContent.
  const row = renderer.renderResult(
    { content: result.content, details: result.details },
    { expanded: false, isPartial: false },
    theme,
    context(),
  );
  const text = row.render(200).join("\n");
  expect(text).toContain("Error (http)");
  expect(text).toContain("example.test/failure");
  expect(text.split("\n").length).toBeLessThanOrEqual(5);
});

it("does not mistake a single article's separators for a batch in legacy preview fallback", () => {
  const renderer = buildFetchRendering("web_fetch");
  const result = presentResult(
    content("https://example.test/article", "First paragraph\n\n---\n\nSecond paragraph"),
  );
  const { previews: _previews, ...legacyDetails } = result.details;
  const row = renderer.renderResult(
    { content: result.content, details: legacyDetails },
    { expanded: false, isPartial: false },
    theme,
    context(),
  );
  expect(row.render(200).join("\n")).toContain("First paragraph");
});

it("renders old upstream details.error as an error without changing execution semantics", () => {
  const renderer = buildFetchRendering("web_fetch");
  const row = renderer.renderResult(
    { content: [{ type: "text", text: "Error: unavailable" }], details: { error: true } },
    { expanded: false, isPartial: false },
    theme,
    context(),
  );
  expect(row.render(100).join("\n")).toContain("✗ error");
});

it("a semantically invalid batch URL fails only that item, without native requests for it", async () => {
  const requests = [{ url: "file:///private" }, { url: "https://example.test/" }];
  expect(isBatchInput({ requests })).toBe(true);
  let calls = 0;
  const result = await executeBatch(
    requests,
    {},
    {
      execute: async (input) => {
        calls++;
        return content(input.url);
      },
    },
  );
  expect(calls).toBe(1);
  expect(result).toMatchObject({
    succeeded: 1,
    failed: 1,
    items: [{ kind: "error", code: "invalid_request" }, { kind: "content" }],
  });
});

it("rejects binary alternates before creating an unreported download", async () => {
  const source = "https://example.test/";
  let downloads = 0;
  const result = await executeFetch(
    { url: source },
    {},
    {
      createOwner: (input, hooks, options) =>
        new RequestOwner(input, hooks, {
          ...options,
          fetch: async (url) => {
            const response =
              url === source
                ? new Response(
                    '<html><head><link rel="alternate" type="text/markdown" href="/unexpected-binary"></head><body><article>Short useful original</article></body></html>',
                    { headers: { "content-type": "text/html" } },
                  )
                : new Response("binary", { headers: { "content-type": "application/pdf" } });
            return {
              url,
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
              body: response.body,
            };
          },
        }),
      download: async () => {
        downloads++;
        throw new Error("Must not download unselected alternates");
      },
    },
  );
  expect(downloads).toBe(0);
  expect(result).toMatchObject({
    kind: "content",
    finalUrl: source,
    warnings: [expect.any(String)],
  });
});

it("does not echo rejected URL userinfo into error metadata", async () => {
  const result = await executeFetch({ url: "https://user:private-secret@example.test/" });
  expect(result).toMatchObject({ kind: "error", code: "invalid_request", url: "" });
  expect(JSON.stringify(result)).not.toContain("private-secret");
});
