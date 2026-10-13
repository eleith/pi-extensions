import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { executeFetch } from "./fetch.ts";
import { RequestOwner, type NativeFetch } from "./transport.ts";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
afterEach(() => vi.restoreAllMocks());

function body(text: string, mime = "text/html", status = 200) {
  const response = new Response([204, 205].includes(status) ? null : text, {
    status,
    headers: { "content-type": mime },
  });
  return {
    url: "",
    status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.body,
  };
}

it("runs real Reddit extraction through the controlled adapter without public egress", async () => {
  const trap = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected public egress"));
  const source = "https://www.reddit.com/r/fixtures/comments/abc/offline";
  const html = await fixture("reddit-old.html");
  const native = vi.fn<NativeFetch>(async (url, init) => {
    if (url === source) return body("<html><body></body></html>");
    expect(url).toBe("https://old.reddit.com/r/fixtures/comments/abc/offline");
    expect(new Headers(init.headers as HeadersInit).get("accept")).toContain("text/html");
    return body(html);
  });
  const result = await executeFetch(
    { url: source, includeReplies: false },
    {},
    {
      createOwner: (input, hooks, options) =>
        new RequestOwner(input, hooks, { ...options, fetch: native }),
    },
  );
  expect(result).toMatchObject({
    kind: "content",
    title: "Offline Reddit post",
    site: "r/fixtures",
    url: source,
  });
  if (result.kind !== "content") throw new Error("Expected content");
  expect(result.content).toContain("A post about offline fixtures");
  expect(result.content).not.toContain("Offline reply content");
  expect(native).toHaveBeenCalledTimes(2);
  expect(trap).not.toHaveBeenCalled();
});

it("runs real YouTube JSON POST/chapter/caption requests through the same owner", async () => {
  const trap = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected public egress"));
  const source = "https://www.youtube.com/watch?v=fixture123";
  const page = await fixture("youtube.html"),
    player = await fixture("youtube-player.json"),
    next = await fixture("youtube-next.json"),
    captions = await fixture("youtube-transcript.xml");
  const native = vi.fn<NativeFetch>(async (url, init) => {
    if (url === source) return body(page);
    if (url === "https://www.youtube.com/api/timedtext?v=fixture123")
      return body(captions, "text/xml");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body)).videoId).toBe("fixture123");
    if (url === "https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
      return body(player, "application/json");
    if (url === "https://www.youtube.com/youtubei/v1/next?prettyPrint=false")
      return body(next, "application/json");
    throw new Error("Unexpected controlled destination");
  });
  const result = await executeFetch(
    { url: source },
    {},
    {
      createOwner: (input, hooks, options) =>
        new RequestOwner(input, hooks, { ...options, fetch: native }),
    },
  );
  expect(result).toMatchObject({
    kind: "content",
    title: "Offline video",
    site: "YouTube",
    url: source,
  });
  if (result.kind !== "content") throw new Error("Expected content");
  expect(result.content).toContain("Welcome to an offline transcript fixture");
  expect(result.content).toContain("Fixture chapter");
  expect(native).toHaveBeenCalledTimes(4);
  expect(trap).not.toHaveBeenCalled();
});

it("runs X fallback APIs through the adapter and keeps the actual HTTP status", async () => {
  const trap = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected public egress"));
  const source = "https://x.com/fixture/status/12345",
    oembed = await fixture("x-oembed.json");
  const native = vi.fn<NativeFetch>(async (url) => {
    if (url === source) return body("<html><body></body></html>");
    if (url === "https://api.fxtwitter.com/fixture/status/12345")
      return body("not found", "text/plain", 404);
    expect(url).toBe(
      "https://publish.twitter.com/oembed?url=https%3A%2F%2Fx.com%2Ffixture%2Fstatus%2F12345&omit_script=true",
    );
    return body(oembed, "application/json");
  });
  const result = await executeFetch(
    { url: source },
    {},
    {
      createOwner: (input, hooks, options) =>
        new RequestOwner(input, hooks, { ...options, fetch: native }),
    },
  );
  expect(result).toMatchObject({
    kind: "content",
    statusCode: 200,
    site: "X (Twitter)",
    author: "@fixture",
  });
  if (result.kind !== "content") throw new Error("Expected content");
  expect(result.content).toContain("offline oEmbed tweet");
  expect(native).toHaveBeenCalledTimes(3);
  expect(trap).not.toHaveBeenCalled();
});

it("a looping native redirect does not erase a useful original or stop a later alternate", async () => {
  const source = "https://example.test/";
  const native = vi.fn<NativeFetch>(async (url) => {
    if (url === source)
      return body(
        '<html><head><link rel="alternate" type="text/markdown" href="/loop"><link rel="alternate" type="text/markdown" href="/good"></head><body><article>short original content</article></body></html>',
      );
    if (url === "https://example.test/loop") {
      const response = body("", "text/html", 302);
      response.headers.set("location", source);
      return response;
    }
    expect(url).toBe("https://example.test/good");
    return body("# Readable alternate\n" + "Complete documentation. ".repeat(30), "text/markdown");
  });
  const result = await executeFetch(
    { url: source },
    {},
    {
      createOwner: (input, hooks, options) =>
        new RequestOwner(input, hooks, { ...options, fetch: native }),
    },
  );
  expect(result).toMatchObject({
    kind: "content",
    url: source,
    finalUrl: "https://example.test/good",
  });
});

it("returns an empty raw HTTP 204 body without manufacturing a download/error", async () => {
  const source = "https://example.test/no-content";
  const native = vi.fn<NativeFetch>(async () => body("", "", 204));
  const result = await executeFetch(
    { url: source, format: "raw" },
    {},
    {
      createOwner: (input, hooks, options) =>
        new RequestOwner(input, hooks, { ...options, fetch: native }),
    },
  );
  expect(result).toMatchObject({ kind: "content", statusCode: 204, content: "", truncated: false });
});

it("cancellation returns without waiting for an uncooperative async extractor", async () => {
  const source = "https://example.test/",
    controller = new AbortController();
  let started: () => void = () => {};
  const extracting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const native = vi.fn<NativeFetch>(async () => body("<html><body>article</body></html>"));
  const execute = executeFetch(
    { url: source },
    { signal: controller.signal },
    {
      createOwner: (input, hooks, options) =>
        new RequestOwner(input, hooks, { ...options, fetch: native }),
      extract: async () => {
        started();
        return new Promise(() => {});
      },
    },
  );
  await extracting;
  controller.abort();
  expect(await execute).toMatchObject({ kind: "error", code: "cancelled" });
});

it("preserves a negotiated Markdown document's initial title without treating code as metadata", async () => {
  const source = "https://example.test/document.md";
  for (const [text, title] of [
    ["# **Document title**\n\nUseful document.", "**Document title**"],
    [
      '<!-- {"title":"Ignored machine title"} -->\n\n# Document title\n\nUseful document.',
      "Document title",
    ],
    ["```text\n# Not a title\n```\n\nDocument body", ""],
  ]) {
    const native = vi.fn<NativeFetch>(async () => body(text, "text/markdown"));
    const result = await executeFetch(
      { url: source },
      {},
      {
        createOwner: (input, hooks, options) =>
          new RequestOwner(input, hooks, { ...options, fetch: native }),
      },
    );
    expect(result).toMatchObject({ kind: "content", title });
  }
});

it("preserves real-owner byte limits before buffered extractor responses return", async () => {
  const source = "https://x.com/fixture/status/12345";
  const fx = await fixture("x-fx.json");
  const native = vi.fn<NativeFetch>(async (url) => {
    if (url === source) return body("<html><body></body></html>");
    expect(url).toBe("https://api.fxtwitter.com/fixture/status/12345");
    return body(fx, "application/json");
  });
  const result = await executeFetch(
    { url: source },
    {},
    {
      createOwner: (input, hooks, options) =>
        new RequestOwner(input, hooks, { ...options, fetch: native, limits: { textBytes: 64 } }),
    },
  );
  expect(result).toMatchObject({ kind: "error", code: "limit" });
  expect(native).toHaveBeenCalledTimes(2);
});

it("malformed buffered extractor JSON remains an ordinary recoverable body error", async () => {
  const source = "https://x.com/fixture/status/12345",
    oembed = await fixture("x-oembed.json");
  const native = vi.fn<NativeFetch>(async (url) => {
    if (url === source) return body("<html><body></body></html>");
    if (url === "https://api.fxtwitter.com/fixture/status/12345")
      return body("not JSON", "application/json");
    expect(url).toBe(
      "https://publish.twitter.com/oembed?url=https%3A%2F%2Fx.com%2Ffixture%2Fstatus%2F12345&omit_script=true",
    );
    return body(oembed, "application/json");
  });
  const result = await executeFetch(
    { url: source },
    {},
    {
      createOwner: (input, hooks, options) =>
        new RequestOwner(input, hooks, { ...options, fetch: native }),
    },
  );
  expect(result).toMatchObject({ kind: "content", statusCode: 200 });
  if (result.kind !== "content") throw new Error("Expected recovered content");
  expect(result.content).toContain("offline oEmbed tweet");
  expect(native).toHaveBeenCalledTimes(3);
});
