import { Type, validateToolArguments, type TSchema, type JsonValue } from "@earendil-works/pi-ai";
import { beforeEach, expect, it, vi } from "vitest";
import type { BatchResult, ContentResult, FetchHooks, FetchResult } from "./core/types.ts";
import { batchOutputSchema, fetchOutputSchema } from "./schema.ts";
import { LIMITS } from "./core/limits.ts";
import { batchTool, fetchTool, presentResult, TOOL_OUTPUT_CHARS } from "./tool.ts";

const mocks = vi.hoisted(() => ({ single: vi.fn(), batch: vi.fn(), loads: vi.fn() }));
vi.mock("./core/fetch.ts", () => {
  mocks.loads("single");
  return { executeFetch: mocks.single };
});
vi.mock("./core/batch.ts", () => {
  mocks.loads("batch");
  return { executeBatch: mocks.batch };
});
beforeEach(() => {
  mocks.single.mockReset();
  mocks.batch.mockReset();
});
const content = (patch: Partial<ContentResult> = {}): ContentResult => ({
  kind: "content",
  url: "https://example.test/requested",
  finalUrl: "https://example.test/final",
  statusCode: 200,
  contentType: "text/html",
  title: "Title",
  author: "Author",
  published: "2026-01-01",
  site: "Site",
  language: "en",
  wordCount: 12,
  content: "Full extracted content\nsecond line",
  truncated: false,
  warnings: [],
  ...patch,
});
const error: FetchResult = {
  kind: "error",
  url: "https://example.test",
  code: "network",
  message: "native transport secret: Authorization=credential",
};
function assertSchema(parameters: TSchema, value: unknown) {
  const wrapper = Type.Object({ value: parameters }, { additionalProperties: false });
  expect(
    validateToolArguments(
      { name: "output", description: "output", parameters: wrapper },
      { type: "toolCall", id: "output", name: "output", arguments: { value: value as JsonValue } },
    ),
  ).toEqual({ value });
}
function batch(items: FetchResult[], patch: Partial<BatchResult> = {}): BatchResult {
  const succeeded = items.filter((item) => item.kind !== "error").length;
  return {
    kind: "batch",
    items,
    total: items.length,
    succeeded,
    failed: items.length - succeeded,
    cancelled: false,
    truncated: false,
    ...patch,
  };
}
it("rejects malformed/extra arguments before importing execution or networking", async () => {
  expect(mocks.loads).not.toHaveBeenCalled();
  for (const args of [
    { url: "https://example.test", headers: { Authorization: "secret" } },
    { url: "file:///etc/passwd" },
    { url: "https://example.test", proxy: "secret" },
  ]) {
    const result = await fetchTool(args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
    assertSchema(fetchOutputSchema, result.structuredContent);
  }
  const result = await batchTool({ requests: [{ url: "https://example.test" }], verbose: true });
  expect(result.isError).toBe(true);
  assertSchema(batchOutputSchema, result.structuredContent);
  expect(mocks.loads).not.toHaveBeenCalled();
  expect(mocks.single).not.toHaveBeenCalled();
  expect(mocks.batch).not.toHaveBeenCalled();
});
it("forwards only validated inputs and actual signal/phase updates", async () => {
  const controller = new AbortController();
  const update = vi.fn();
  mocks.single.mockImplementation(async (_input: unknown, hooks: FetchHooks) => {
    expect(hooks.signal).toBe(controller.signal);
    hooks.onProgress?.({ phase: "connecting" });
    hooks.onProgress?.({ phase: "reading" });
    hooks.onProgress?.({ phase: "extracting" });
    return content();
  });
  const input = { url: "https://example.test", format: "raw" };
  const result = await fetchTool(input, controller.signal, update);
  expect(mocks.single).toHaveBeenCalledWith(
    input,
    expect.objectContaining({ signal: controller.signal }),
  );
  expect(update.mock.calls.map(([result]) => result.details.status)).toEqual([
    "connecting",
    "reading",
    "extracting",
  ]);
  expect(update.mock.calls.every(([result]) => result.content.length === 0)).toBe(true);
  expect(result.isError).toBe(false);
  expect(result.details).toEqual({
    version: 1,
    status: "done",
    kind: "content",
    completed: 1,
    total: 1,
    succeeded: 1,
    failed: 0,
    truncated: false,
    previews: [
      "https://example.test/final",
      "HTTP 200 · Title",
      "Full extracted content",
      "second line",
    ],
  });
  expect(result.details).not.toHaveProperty("content");
  expect(result.details).not.toHaveProperty("requests");
  assertSchema(fetchOutputSchema, result.structuredContent);
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("Title: Title\nAuthor: Author"),
  });
  expect(result.content[0]).toMatchObject({
    text: expect.stringContaining("Full extracted content\nsecond line"),
  });
});
it("returns matching structured data and real Pi errors without native credentials", async () => {
  mocks.single.mockResolvedValue(error);
  const failed = await fetchTool({ url: "https://example.test" });
  expect(failed.isError).toBe(true);
  expect(failed.structuredContent).toMatchObject({
    kind: "error",
    code: "network",
    message: "Network request failed.",
  });
  expect(JSON.stringify(failed)).not.toContain("credential");
  assertSchema(fetchOutputSchema, failed.structuredContent);
  mocks.single.mockRejectedValue(Error("native proxy=user:secret password"));
  const unexpected = await fetchTool({ url: "https://example.test" });
  expect(unexpected.isError).toBe(true);
  expect(JSON.stringify(unexpected)).not.toContain("secret");
  assertSchema(fetchOutputSchema, unexpected.structuredContent);
  const noStatus = presentResult({
    kind: "error",
    url: "",
    code: "extraction",
    message: "nothing",
  });
  expect(noStatus.structuredContent).not.toHaveProperty("statusCode");
  expect(noStatus.content[0]).toMatchObject({ text: expect.not.stringContaining("HTTP") });
});
it("retains ordered items and marks only cancelled or all-failed batches as Pi errors", async () => {
  for (const [outcome, isError] of [
    [batch([content(), error]), false],
    [batch([error, error]), true],
    [batch([content(), { ...error, code: "cancelled" }], { cancelled: true }), true],
  ] as const) {
    mocks.batch.mockResolvedValue(outcome);
    const result = await batchTool({ requests: outcome.items.map((item) => ({ url: item.url })) });
    expect(result.isError).toBe(isError);
    expect(result.details?.total).toBe(2);
    expect(result.structuredContent).toMatchObject({
      items: outcome.items.map((item) => ({ kind: item.kind })),
    });
    expect(JSON.stringify(result)).not.toContain("credential");
    assertSchema(batchOutputSchema, result.structuredContent);
  }
});
it("retains cancelled terminal states rather than racing away core results", async () => {
  const controller = new AbortController();
  mocks.batch.mockImplementation(async (_inputs: unknown, hooks: FetchHooks) => {
    controller.abort();
    expect(hooks.signal?.aborted).toBe(true);
    return batch([content(), { ...error, code: "cancelled" }], { cancelled: true });
  });
  const result = await batchTool(
    { requests: [{ url: "https://one.test" }, { url: "https://two.test" }] },
    controller.signal,
  );
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    cancelled: true,
    succeeded: 1,
    failed: 1,
    items: [{ kind: "content" }, { kind: "error", code: "cancelled" }],
  });
});
it("retains long usable file paths in structured results while bounding extreme batch previews", () => {
  for (const unit of ["x", "\\", "模型🙂"]) {
    const filePath = `/workspace/${unit.repeat(1600)}/download.pdf`.slice(0, 4000);
    const items: FetchResult[] = Array.from({ length: 24 }, () => ({
      kind: "file",
      url: "https://example.test",
      finalUrl: "https://example.test/final",
      statusCode: 200,
      contentType: "application/pdf",
      filePath,
      fileSize: 12345,
    }));
    const result = presentResult(batch(items));
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_OUTPUT_CHARS);
    assertSchema(batchOutputSchema, result.structuredContent);
    expect(result.structuredContent).toMatchObject({
      items: Array.from({ length: 24 }, () => ({ filePath })),
    });
  }
});

it("exposes local file paths, actual bytes/status, without making downloads read-only", () => {
  const result = presentResult({
    kind: "file",
    url: "https://example.test/start",
    finalUrl: "https://example.test/file",
    statusCode: 200,
    contentType: "application/pdf",
    filePath: "/workspace/private/download.pdf",
    fileSize: 12345,
  });
  expect(result.isError).toBe(false);
  assertSchema(fetchOutputSchema, result.structuredContent);
  expect(result.content[0]).toMatchObject({
    text: expect.stringContaining("File: /workspace/private/download.pdf\nBytes: 12345"),
  });
});
it.each(["x", '"\\\n\u0000', "模型🙂"])(
  "bounds combined serialized model/structured/details output for %j",
  (unit) => {
    const huge = unit.repeat(110_000);
    const outcome = batch(
      Array.from({ length: 24 }, () =>
        content({
          url: huge,
          finalUrl: huge,
          title: huge,
          author: huge,
          published: huge,
          site: huge,
          language: huge,
          contentType: huge,
          content: huge,
          warnings: Array.from({ length: 100 }, () => huge),
        }),
      ),
    );
    for (const value of [content({ content: huge }), outcome]) {
      const result = presentResult(value);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_OUTPUT_CHARS);
      expect(result.details?.truncated).toBe(true);
      assertSchema(
        value.kind === "batch" ? batchOutputSchema : fetchOutputSchema,
        result.structuredContent,
      );
      expect(JSON.stringify(result.details).length).toBeLessThan(4096);
      if (value.kind === "batch") {
        expect(result.structuredContent).toMatchObject({
          total: 24,
          succeeded: 24,
          truncated: true,
        });
        const bounded = result.structuredContent as unknown as BatchResult;
        const rows = bounded.items.filter((item) => item.kind === "content");
        expect(rows).toHaveLength(24);
        expect(rows.reduce((n, item) => n + item.content.length, 0)).toBeLessThanOrEqual(
          LIMITS.batchChars,
        );
        for (const item of rows) {
          expect(item.truncated).toBe(true);
          expect(item.warnings.length).toBeLessThanOrEqual(8);
        }
      }
    }
  },
);

it("reduces serialization proportionally after input-order allocation and keeps text/data aligned", () => {
  const items = Array.from({ length: 24 }, (_, index) =>
    content({
      url: `https://example.test/${index}?query=${"\\".repeat(7000)}`,
      finalUrl: `https://example.test/${index}?query=${"\\".repeat(7000)}`,
      content: "\u0000".repeat(LIMITS.maxChars),
    }),
  );
  const result = presentResult(batch(items));
  const data = result.structuredContent as unknown as BatchResult;
  const rows = data.items.filter((item) => item.kind === "content");
  expect(rows).toHaveLength(24);
  expect(rows[0].content.length).toBeGreaterThan(0);
  expect(rows[0].content.length).toBeLessThan(LIMITS.maxChars);
  expect(rows[0].content.length).toBe(rows[1].content.length);
  expect(rows[0].warnings).toContain("Tool output budget truncated content.");
  expect(rows[2].content).toBe("");
  expect(rows.map((item) => item.url)).toEqual(items.map((item) => item.url));
  const text = result.content[0];
  if (text.type !== "text") throw new Error("Expected model text");
  const sections = text.text.replace(/^Batch:[^\n]*\n\n/, "").split("\n\n---\n\n");
  expect(sections).toHaveLength(24);
  for (const [index, section] of sections.entries()) {
    expect(section.slice(section.indexOf("\n\n") + 2)).toBe(rows[index].content);
  }
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_OUTPUT_CHARS);
  assertSchema(batchOutputSchema, result.structuredContent);
});
