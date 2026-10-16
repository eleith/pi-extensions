import { beforeEach, expect, it, vi } from "vitest";
import { RequestOwner, type NativeFetch } from "./core/transport.ts";
import { batchTool, fetchTool } from "./tool.ts";

const native = vi.hoisted(() => vi.fn<NativeFetch>());
// Use the real pipeline with an injected transport, never public network access.
vi.mock("./core/fetch.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./core/fetch.ts")>();
  const executeFetch: typeof actual.executeFetch = (input, hooks, dependencies) =>
    actual.executeFetch(input, hooks, {
      ...dependencies,
      createOwner: (request, callbacks, options) =>
        new RequestOwner(request, callbacks, { ...options, fetch: native }),
    });
  return { ...actual, executeFetch };
});
beforeEach(() => native.mockReset());

function response(text: string, mime: string) {
  const result = new Response(text, { headers: { "content-type": mime } });
  return {
    url: "",
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    body: result.body,
  };
}

const url = "https://example.test/data";
const message = "Response is not valid JSON. Retry with format raw to inspect the response body.";

it.each([
  { format: "json", mime: "text/html", body: "<html><body>private-body</body></html>" },
  { format: "json", mime: "text/plain", body: "private-body" },
  { format: "markdown", mime: "application/json", body: '{"private-body":' },
  { format: "html", mime: "application/problem+json", body: "private-body" },
] as const)(
  "reports a safe JSON diagnostic for $format from $mime",
  async ({ format, mime, body }) => {
    native.mockImplementation(async () => response(body, mime));
    const result = await fetchTool({ url, format });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ kind: "error", url, code: "invalid_json", message });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(message) });
    expect(JSON.stringify(result)).not.toContain("private-body");
    expect(native).toHaveBeenCalledOnce();
  },
);

it("keeps JSON failures isolated and ordered in a mixed batch", async () => {
  native.mockImplementation(async (target) =>
    target === url
      ? response("private-body", "application/json")
      : response('{ "ok": true }', "application/json"),
  );
  const result = await batchTool({
    requests: [
      { url, format: "json" },
      { url: "https://example.test/good", format: "json" },
    ],
  });
  expect(result.structuredContent).toMatchObject({
    total: 2,
    succeeded: 1,
    failed: 1,
    items: [
      { kind: "error", code: "invalid_json", message },
      { kind: "content", content: '{ "ok": true }' },
    ],
  });
  expect(result.isError).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private-body");
});

it.each([false, true])(
  "still attempts a JSON alternate before reporting the original failure (valid=%s)",
  async (valid) => {
    native.mockImplementation(async (target) =>
      target === url
        ? response(
            '<html><head><link rel="alternate" type="application/json" href="/alternate"></head><body>private-body</body></html>',
            "text/html",
          )
        : response(valid ? '{"ok":true}' : "private-body", "application/json"),
    );
    const result = await fetchTool({ url, format: "json" });
    expect(native.mock.calls.map(([target]) => target)).toEqual([
      url,
      "https://example.test/alternate",
    ]);
    expect(result.isError).toBe(!valid);
    expect(result.structuredContent).toMatchObject(
      valid
        ? {
            kind: "content",
            url,
            finalUrl: "https://example.test/alternate",
            content: '{"ok":true}',
          }
        : { kind: "error", url, code: "invalid_json", message },
    );
  },
);

it("allows an explicit raw retry of malformed JSON", async () => {
  native.mockImplementation(async () => response('{"broken":', "application/json"));
  const result = await fetchTool({ url, format: "raw" });
  expect(result.isError).toBe(false);
  expect(result.structuredContent).toMatchObject({ kind: "content", content: '{"broken":' });
});

it("keeps valid JSON truncation a content result, not a JSON validation failure", async () => {
  native.mockImplementation(async () => response('{"ok":true}', "application/json"));
  const result = await fetchTool({ url, format: "json", maxChars: 5 });
  expect(result.isError).toBe(false);
  expect(result.structuredContent).toMatchObject({
    kind: "content",
    content: '{"ok"',
    truncated: true,
    warnings: [expect.stringContaining("not necessarily valid serialized data")],
  });
});
