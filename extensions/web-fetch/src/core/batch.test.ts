import { expect, it, vi } from "vitest";
import { executeBatch, type BatchDependencies } from "./batch.ts";
import { LIMITS } from "./limits.ts";
import { TransportError } from "./transport.ts";
import type { ContentResult } from "./types.ts";

function result(url: string, text = "document"): ContentResult {
  return {
    kind: "content",
    url,
    finalUrl: url,
    statusCode: 200,
    contentType: "text/plain",
    title: "",
    author: "",
    published: "",
    site: "example.test",
    language: "en",
    wordCount: 100,
    content: text,
    truncated: false,
    warnings: [],
  };
}
type Executor = NonNullable<BatchDependencies["execute"]>;
const urls = Array.from({ length: 8 }, (_, i) => `https://example.test/${i}`);

it("bounds workers, isolates thrown item errors, and preserves input order", async () => {
  let active = 0,
    peak = 0;
  const execute = vi.fn<Executor>(async (input) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, input.url.endsWith("0") ? 20 : 1));
      if (input.url.endsWith("2")) throw new TransportError("network", "Source unavailable.");
      return result(input.url);
    } finally {
      active--;
    }
  });
  const batch = await executeBatch(
    urls.map((url) => ({ url })),
    {},
    { execute },
  );
  expect(peak).toBe(LIMITS.batchConcurrency);
  expect(batch.items.map((item) => item.url)).toEqual(urls);
  expect(batch).toMatchObject({ total: 8, succeeded: 7, failed: 1, cancelled: false });
  expect(batch.items[2]).toMatchObject({ kind: "error", code: "network" });
});

it("validates every request before work and never executes invalid items", async () => {
  const execute = vi.fn<Executor>(async (input) => result(input.url));
  const batch = await executeBatch(
    [{ url: urls[0] }, { url: "file:///private" }, { url: urls[2] }],
    {},
    { execute },
  );
  expect(execute).toHaveBeenCalledTimes(2);
  expect(batch).toMatchObject({ succeeded: 2, failed: 1 });
  expect(batch.items[1]).toMatchObject({ kind: "error", code: "invalid_request" });
});

it("does not start queued work after cancellation", async () => {
  const controller = new AbortController();
  const execute = vi.fn<Executor>(async (input) => {
    controller.abort();
    return {
      kind: "error" as const,
      url: input.url,
      code: "cancelled" as const,
      message: "Request cancelled.",
    };
  });
  const batch = await executeBatch(
    urls.map((url) => ({ url })),
    { signal: controller.signal },
    { execute },
  );
  expect(execute).toHaveBeenCalledOnce();
  expect(batch).toMatchObject({ total: 8, succeeded: 0, failed: 8, cancelled: true });
  expect(batch.items.every((item) => item.kind === "error" && item.code === "cancelled")).toBe(
    true,
  );
});

it("shares accepted-byte quota and starts deadlines before worker admission", async () => {
  const started = Date.now();
  const execute = vi.fn<Executor>(async (input, _hooks, dependencies) => {
    expect(dependencies.deadlineAt).toBeGreaterThanOrEqual(started + 1000);
    expect(dependencies.deadlineAt).toBeLessThanOrEqual(started + 1100);
    if (!dependencies.budget) throw new Error("Missing shared budget");
    dependencies.budget.used += 8;
    return result(input.url);
  });
  const batch = await executeBatch(
    urls.map((url) => ({ url, timeoutMs: 1000 })),
    {},
    { execute, byteLimit: 8, concurrency: 1 },
  );
  expect(execute).toHaveBeenCalledOnce();
  expect(batch).toMatchObject({ succeeded: 1, failed: 7 });
  expect(batch.items[1]).toMatchObject({ kind: "error", code: "limit" });
});

it("allocates content quota in input order and reports truncation without hiding items", async () => {
  const execute = vi.fn<Executor>(async (input) => result(input.url, "x".repeat(LIMITS.maxChars)));
  const batch = await executeBatch(
    urls.slice(0, 4).map((url) => ({ url })),
    {},
    { execute },
  );
  const contentItems = batch.items.filter((item) => item.kind === "content");
  expect(contentItems.reduce((n, item) => n + item.content.length, 0)).toBe(LIMITS.batchChars);
  expect(contentItems[0].truncated).toBe(false);
  expect(contentItems[1].truncated).toBe(false);
  expect(contentItems[2]).toMatchObject({
    truncated: true,
    content: "",
    warnings: [expect.any(String)],
  });
  expect(batch).toMatchObject({ total: 4, succeeded: 4, failed: 0, truncated: true });
});

it.each([
  { requests: [] },
  { requests: Array.from({ length: LIMITS.maxRequests + 1 }, () => ({ url: urls[0] })) },
])("rejects invalid batch sizes without work", async ({ requests }) => {
  const execute = vi.fn();
  const batch = await executeBatch(requests, {}, { execute });
  expect(execute).not.toHaveBeenCalled();
  expect(batch).toMatchObject({ succeeded: 0, failed: 1 });
  expect(batch.items[0]).toMatchObject({ kind: "error", code: "invalid_request" });
});
