/// <reference lib="dom" />
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractContent } from "./extract.ts";
import { parseLinkedomHTML } from "./dom.ts";
import { LIMITS } from "./limits.ts";
import type { OutputFormat } from "./types.ts";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const url = "https://example.test/article";
const noNetwork: typeof fetch = async () => {
  throw new Error("Unexpected controlled request");
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("real Defuddle + Linkedom structured extraction", () => {
  it("matches the real invocation used by the pinned upstream article pipeline", async () => {
    const body = await fixture("article.html");
    const { Defuddle } = await import("defuddle/node");
    const expected = await Defuddle(await parseLinkedomHTML(body, url), url, {
      markdown: true,
      removeImages: false,
      includeReplies: "extractors",
      fetch: noNetwork,
    });
    const result = await extractContent(
      body,
      url,
      { url: "https://example.test/original" },
      noNetwork,
      undefined,
      "text/html; charset=utf-8",
      201,
    );
    expect(result.content).toBe(expected.content.trim());
    expect(result).toMatchObject({
      kind: "content",
      url: "https://example.test/original",
      finalUrl: url,
      statusCode: 201,
      title: "Offline extraction guide",
      author: "Ada Fixture",
      site: "Fixture Notes",
      language: "en",
      truncated: false,
      warnings: [],
    });
    expect(result.published).toContain("2026-01-02");
    expect(result.content).toContain("```js\nconst answer = 42;");
    expect(result.content).toContain("| Tool | Result |");
    expect(result.content).toContain("[the guide](https://example.test/guide)");
    expect(result.content).toContain("![Fixture image]");
    expect(result.content).not.toContain("Navigation noise");
  });

  it("uses real HTML extraction and removes images on request", async () => {
    const body = await fixture("article.html");
    const html = await extractContent(
      body,
      url,
      { url, format: "html" },
      noNetwork,
      undefined,
      "text/html",
    );
    expect(html.content).toContain("<table>");
    expect(html.content).toContain('<code class="language-js"');
    expect(html.content).not.toContain("```js");
    const removed = await extractContent(
      body,
      url,
      { url, removeImages: true },
      noNetwork,
      undefined,
      "text/html",
    );
    expect(removed.content).not.toContain("photo.png");
  });

  it("does not change console or DOM globals across concurrent real extraction", async () => {
    const keys = [
      "window",
      "Window",
      "document",
      "Node",
      "HTMLElement",
      "getComputedStyle",
    ] as const;
    const before = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    const consoleError = console.error;
    const body = await fixture("article.html");
    await Promise.all([
      extractContent(body, url, { url }, noNetwork, undefined, "text/html"),
      extractContent(body, url, { url, format: "html" }, noNetwork, undefined, "text/html"),
    ]);
    expect(console.error).toBe(consoleError);
    expect(keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key))).toEqual(before);
  });
});

describe("formats and bounded output", () => {
  it("raw bypasses X async extraction and preserves decoded body without synthetic HTTP status", async () => {
    const fetcher = vi.fn(noNetwork);
    const body = "<html><body>JavaScript disabled</body></html>";
    const x = "https://x.com/fixture/status/12345";
    const result = await extractContent(
      body,
      x,
      { url: x, format: "raw" },
      fetcher,
      undefined,
      "text/html",
      202,
    );
    expect(result.content).toBe(body);
    expect(result.statusCode).toBe(202);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["markdown", "html", "json"] as OutputFormat[])(
    "parses JSON and renders %s",
    async (format) => {
      const result = await extractContent(
        '{"label":"<value>","items":[1,2]}',
        url,
        { url, format },
        noNetwork,
        undefined,
        "application/problem+json",
      );
      if (format === "html") expect(result.content).toContain("&lt;value&gt;");
      else if (format === "markdown") expect(result.content).toMatch(/^```json\n/);
      else expect(JSON.parse(result.content)).toEqual({ label: "<value>", items: [1, 2] });
    },
  );

  it("keeps ordinary API JSON in its original representation through the public extraction path", async () => {
    const value = { text: '[{\\"quoted}]', values: [1, true, null] };
    const result = await extractContent(
      JSON.stringify(value),
      url,
      { url, format: "json" },
      noNetwork,
      undefined,
      "application/json",
    );
    expect(result.content).toBe(JSON.stringify(value));
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("distinguishes valid JSON-looking plaintext from malformed JSON and HTML", async () => {
    const parsed = await extractContent(
      '{"a":1}',
      url,
      { url },
      noNetwork,
      undefined,
      "text/plain",
    );
    expect(parsed.content).toContain("```json");
    const text = await extractContent(
      "{not JSON: keep this text}",
      url,
      { url },
      noNetwork,
      undefined,
      "text/plain",
    );
    expect(text.content).toBe("{not JSON: keep this text}");
    await expect(
      extractContent("{broken", url, { url }, noNetwork, undefined, "application/json"),
    ).rejects.toThrow("valid JSON");
    await expect(
      extractContent(
        "<html><body>Hello</body></html>",
        url,
        { url, format: "json" },
        noNetwork,
        undefined,
        "text/html",
      ),
    ).rejects.toThrow("valid JSON");
  });

  it("keeps plaintext/Markdown inputs intact and escapes plain text for HTML", async () => {
    const literal = 'x < y & z\nconst html = "<article>";';
    expect(
      (await extractContent(literal, url, { url }, noNetwork, undefined, "text/plain")).content,
    ).toBe(literal);
    expect(
      (
        await extractContent(
          literal,
          url,
          { url, format: "html" },
          noNetwork,
          undefined,
          "text/plain",
        )
      ).content,
    ).toContain("x &lt; y &amp; z");
    const markdown =
      "# Heading\n\n[Guide](https://example.test) ![Useful image](photo.png)\n\n`foo_bar_baz` and foo_bar_baz";
    const result = await extractContent(
      markdown,
      url,
      { url },
      noNetwork,
      undefined,
      "text/markdown",
    );
    expect(result.content).toBe(markdown);
  });

  it("bounds defaults, hard caps, metadata and truthful serialization warnings", async () => {
    const body = "x".repeat(110_000);
    const defaults = await extractContent(body, url, { url, format: "raw" }, noNetwork);
    expect(defaults.content).toHaveLength(50_000);
    expect(defaults.truncated).toBe(true);
    const hard = await extractContent(
      body,
      url,
      { url, format: "raw", maxChars: 999_999 },
      noNetwork,
    );
    expect(hard.content).toHaveLength(100_000);
    expect(hard.warnings[0]).toContain("partial body");
    const json = await extractContent(
      '{"long":"123456789"}',
      url,
      { url, format: "json", maxChars: 8 },
      noNetwork,
      undefined,
      "application/json",
    );
    expect(json.truncated).toBe(true);
    expect(json.content.length).toBeLessThanOrEqual(8);
    expect(json.warnings[0]).toContain("not necessarily valid");
    const html = `<html><head><title>${"T".repeat(2_000)}</title></head><body><article><p>${"Useful words ".repeat(60)}</p></article></body></html>`;
    const metadata = await extractContent(html, url, { url }, noNetwork, undefined, "text/html");
    expect(metadata.title).toHaveLength(LIMITS.maxMetadataChars);
    const readable = await extractContent(
      body,
      url,
      { url, maxChars: 40 },
      noNetwork,
      undefined,
      "text/plain",
    );
    expect(readable.content.length).toBeLessThanOrEqual(40);
    expect(readable.content).toContain("[Content truncated]");
  });

  it("does not start after cancellation", async () => {
    const signal = AbortSignal.abort(new Error("cancel reason"));
    await expect(
      extractContent("raw", url, { url, format: "raw" }, noNetwork, signal),
    ).rejects.toThrow("cancel reason");
  });
});

describe("extraction failure and explicit raw retry", () => {
  const source =
    "<html><head><title>Original</title></head><body><article>Readable original content</article></body></html>";

  it.each(["markdown", "html"] as OutputFormat[])(
    "does not replace failed %s extraction with another converter",
    async (format) => {
      const library = await import("defuddle/node");
      const extract = vi.spyOn(library, "Defuddle").mockImplementation(async (document) => {
        (document as Document).body.innerHTML = "<p>Mutation poison</p>";
        throw new Error("Internal request credential must not be serialized");
      });
      const error = await extractContent(
        source,
        url,
        { url, format },
        noNetwork,
        undefined,
        "text/html",
      ).catch((failure) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Retry with format raw");
      expect(error.message).not.toContain("credential");
      expect(extract).toHaveBeenCalledOnce();
      const raw = await extractContent(
        source,
        url,
        { url, format: "raw" },
        noNetwork,
        undefined,
        "text/html",
      );
      expect(raw.content).toBe(source);
      expect(extract).toHaveBeenCalledOnce();
    },
  );

  it("treats empty extraction as failure instead of converting the original DOM", async () => {
    const library = await import("defuddle/node");
    vi.spyOn(library, "Defuddle").mockImplementation(async (document) => {
      (document as Document).body.innerHTML = "";
      return { content: "" } as Awaited<ReturnType<typeof library.Defuddle>>;
    });
    await expect(
      extractContent(source, url, { url }, noNetwork, undefined, "text/html"),
    ).rejects.toThrow("Retry with format raw");
  });

  it("rethrows deadline/cap exceptions instead of replacing their terminal meaning", async () => {
    const library = await import("defuddle/node");
    const failure = Object.assign(new Error("accepted-byte cap"), { code: "limit" });
    vi.spyOn(library, "Defuddle").mockRejectedValue(failure);
    await expect(
      extractContent(source, url, { url }, noNetwork, undefined, "text/html"),
    ).rejects.toBe(failure);
  });
});

describe("real offline async site extractors (controlled fetch only)", () => {
  function trapPublicNetwork() {
    const trap = vi.fn(async () => {
      throw new Error("Unexpected global public network");
    });
    vi.stubGlobal("fetch", trap);
    return trap;
  }

  it("extracts Reddit old HTML and replies through supplied fetch without cache leakage", async () => {
    const trap = trapPublicNetwork();
    const html = await fixture("reddit-old.html");
    const requests: string[] = [];
    const fetcher: typeof fetch = async (target, init) => {
      requests.push(String(target));
      expect(String(target)).toBe("https://old.reddit.com/r/fixtures/comments/abc/offline");
      expect(new Headers(init?.headers).get("accept")).toContain("text/html");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(html, { headers: { "content-type": "text/html" } });
    };
    const reddit = "https://www.reddit.com/r/fixtures/comments/abc/offline";
    for (const includeReplies of [true, false]) {
      const result = await extractContent(
        "<html><body></body></html>",
        reddit,
        { url: reddit, includeReplies },
        fetcher,
        undefined,
        "text/html",
      );
      expect(result).toMatchObject({
        title: "Offline Reddit post",
        author: "post_author",
        site: "r/fixtures",
      });
      expect(result.content).toContain("A post about offline fixtures");
      expect(result.content.includes("Offline reply content")).toBe(includeReplies);
      expect(result.content).toContain("legitimate app code");
    }
    expect(requests).toHaveLength(2);
    expect(trap).not.toHaveBeenCalled();
  });

  it("uses Reddit Atom fallback with response status and text methods", async () => {
    const trap = trapPublicNetwork();
    const feed = await fixture("reddit-feed.xml");
    const requests: string[] = [];
    const fetcher: typeof fetch = async (target) => {
      const requested = String(target);
      requests.push(requested);
      if (requested === "https://old.reddit.com/r/fixtures/comments/feedfixture/offline")
        return new Response("blocked", { status: 403 });
      if (requested === "https://www.reddit.com/r/fixtures/comments/feedfixture/offline/.rss")
        return new Response(feed, { headers: { "content-type": "application/atom+xml" } });
      throw new Error("Unexpected controlled destination");
    };
    const reddit = "https://www.reddit.com/r/fixtures/comments/feedfixture/offline";
    const result = await extractContent(
      "<html><body></body></html>",
      reddit,
      { url: reddit },
      fetcher,
      undefined,
      "text/html",
    );
    expect(result.title).toBe("Atom fixture post");
    expect(result.content).toContain("Atom post body");
    expect(result.content).toContain("Atom reply fixture content");
    expect(requests).toHaveLength(2);
    expect(trap).not.toHaveBeenCalled();
  });

  it("extracts YouTube transcripts using JSON POST, chapter JSON and caption text", async () => {
    const trap = trapPublicNetwork();
    const player = await fixture("youtube-player.json");
    const next = await fixture("youtube-next.json");
    const transcript = await fixture("youtube-transcript.xml");
    const requests: string[] = [];
    const owner = new AbortController();
    const fetcher: typeof fetch = async (target, init) => {
      const requested = String(target);
      requests.push(requested);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (requested === "https://www.youtube.com/api/timedtext?v=fixture123")
        return new Response(transcript);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(init?.body as string).videoId).toBe("fixture123");
      if (requested === "https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
        return new Response(player, { headers: { "content-type": "application/json" } });
      if (requested === "https://www.youtube.com/youtubei/v1/next?prettyPrint=false")
        return new Response(next, { headers: { "content-type": "application/json" } });
      throw new Error("Unexpected controlled destination");
    };
    const video = "https://www.youtube.com/watch?v=fixture123";
    const result = await extractContent(
      await fixture("youtube.html"),
      video,
      { url: video },
      fetcher,
      owner.signal,
      "text/html",
    );
    expect(result).toMatchObject({
      title: "Offline video",
      author: "Fixture Channel",
      site: "YouTube",
    });
    expect(result.content).toContain("Welcome to an offline transcript fixture");
    expect(result.content).toContain("Fixture chapter");
    expect(requests).toHaveLength(3);
    expect(trap).not.toHaveBeenCalled();
  });

  it("preserves rendered X threads while excluding only other-author replies", async () => {
    const trap = trapPublicNetwork();
    const x = "https://x.com/fixture/status/22222";
    const fetcher = vi.fn(noNetwork);
    for (const format of ["markdown", "html"] as const) {
      for (const includeReplies of [true, false]) {
        const result = await extractContent(
          await fixture("x-thread.html"),
          x,
          { url: x, format, includeReplies },
          fetcher,
          undefined,
          "text/html",
        );
        expect(result.site).toBe("X (Twitter)");
        expect(result.content).toContain("Main offline thread post");
        expect(result.content).toContain("Self-reply remains part of the post");
        expect(result.content.includes("Other-author reply can be excluded")).toBe(includeReplies);
      }
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });

  it("extracts X FxTwitter and oEmbed fallback without fabricated status or console interception", async () => {
    const trap = trapPublicNetwork();
    const before = console.error;
    const fx = await fixture("x-fx.json");
    const oembed = await fixture("x-oembed.json");
    for (const fallback of [false, true]) {
      const requests: string[] = [];
      const fetcher: typeof fetch = async (target, init) => {
        const requested = String(target);
        requests.push(requested);
        if (requested === "https://api.fxtwitter.com/fixture/status/12345") {
          expect(new Headers(init?.headers).get("user-agent")).toContain("Defuddle");
          return fallback ? new Response("not found", { status: 404 }) : new Response(fx);
        }
        if (
          requested ===
          "https://publish.twitter.com/oembed?url=https%3A%2F%2Fx.com%2Ffixture%2Fstatus%2F12345&omit_script=true"
        )
          return new Response(oembed);
        throw new Error("Unexpected controlled destination");
      };
      const x = "https://x.com/fixture/status/12345";
      const result = await extractContent(
        "<html><body></body></html>",
        x,
        { url: x },
        fetcher,
        undefined,
        "text/html",
        200,
      );
      expect(result.site).toBe("X (Twitter)");
      expect(result.author).toBe("@fixture");
      expect(result.statusCode).toBe(200);
      expect(result.content).toContain(
        fallback ? "offline oEmbed tweet" : "complete offline tweet",
      );
      expect(requests).toHaveLength(fallback ? 2 : 1);
    }
    expect(console.error).toBe(before);
    expect(trap).not.toHaveBeenCalled();
  });

  it("preserves terminal errors raised while the adapter reads/validates before returning a response", async () => {
    const x = "https://x.com/fixture/status/98765";
    const failure = Object.assign(new Error("Shared body cap"), { code: "limit" });
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw failure;
    });
    const before = console.error;
    await expect(
      extractContent(
        "<html><body>Original shell</body></html>",
        x,
        { url: x },
        fetcher,
        undefined,
        "text/html",
      ),
    ).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const unsupported = Object.assign(new Error("Unsupported extractor request operation."), {
      code: "invalid_request",
    });
    await expect(
      extractContent(
        "<html><body>Original shell</body></html>",
        x,
        { url: x },
        async () => {
          throw unsupported;
        },
        undefined,
        "text/html",
      ),
    ).rejects.toBe(unsupported);
    expect(console.error).toBe(before);
  });

  it("keeps real HTTP status and console identity when X async requests fail", async () => {
    const trap = trapPublicNetwork();
    const before = console.error;
    const x = "https://x.com/fixture/status/76543";
    const result = await extractContent(
      "<html><body><p>JavaScript disabled original response.</p></body></html>",
      x,
      { url: x },
      async () => new Response("not found", { status: 404 }),
      undefined,
      "text/html",
      200,
    );
    expect(result.statusCode).toBe(200);
    expect(result.content).toContain("JavaScript disabled original response");
    expect(console.error).toBe(before);
    expect(trap).not.toHaveBeenCalled();
  });

  it("does not swallow owner cancellation or cap errors inside async extractors", async () => {
    const owner = new AbortController();
    const failure = Object.assign(new Error("Shared byte cap"), { code: "limit" });
    const fetcher: typeof fetch = async () => {
      throw failure;
    };
    const x = "https://x.com/fixture/status/99999";
    await expect(
      extractContent(
        "<html><body><p>Thin original</p></body></html>",
        x,
        { url: x },
        fetcher,
        owner.signal,
        "text/html",
      ),
    ).rejects.toBe(failure);
    const aborter: typeof fetch = async (_target, init) => {
      owner.abort(new Error("owner deadline"));
      expect(init?.signal?.aborted).toBe(true);
      return new Response(await fixture("x-fx.json"));
    };
    await expect(
      extractContent(
        "<html><body></body></html>",
        x,
        { url: x },
        aborter,
        owner.signal,
        "text/html",
      ),
    ).rejects.toThrow("owner deadline");
  });
});

describe("controlled extractor fetch invariants (generic fault injection)", () => {
  it.each([false, true])(
    "returns the plain buffered response and combines signals (init override: %s)",
    async (override) => {
      const owner = new AbortController();
      const requester = new AbortController();
      const initializer = new AbortController();
      const request = new Request(url, { signal: requester.signal });
      let consumed = false;
      const buffered = new Response('{"value":1}', { status: 201 });
      const fetcher = vi.fn<typeof fetch>(async (_request, init) => {
        expect(init?.signal).not.toBe(owner.signal);
        expect(init?.signal?.aborted).toBe(false);
        requester.abort();
        expect(init?.signal?.aborted).toBe(!override);
        if (override) initializer.abort();
        expect(init?.signal?.aborted).toBe(true);
        return buffered;
      });
      const library = await import("defuddle/node");
      vi.spyOn(library, "Defuddle").mockImplementation(async (_document, _url, options) => {
        const response = await options!.fetch!(
          request,
          override ? { signal: initializer.signal } : undefined,
        );
        expect(response).toBe(buffered);
        expect(response.status).toBe(201);
        expect(response.body).toBeInstanceOf(ReadableStream);
        const copied = response.clone();
        expect(await response.json()).toEqual({ value: 1 });
        expect(await copied.text()).toBe('{"value":1}');
        consumed = true;
        return { content: "Adapter extraction" } as Awaited<ReturnType<typeof library.Defuddle>>;
      });
      const result = await extractContent(
        "<html><body>Fallback</body></html>",
        url,
        { url },
        fetcher,
        owner.signal,
        "text/html",
      );
      expect(result.content).toBe("Adapter extraction");
      expect(consumed).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("gives owner abort priority over a remembered terminal failure", async () => {
    const owner = new AbortController();
    const failure = Object.assign(new Error("Body cap"), { code: "limit" });
    const abort = new Error("Owner cancelled");
    const library = await import("defuddle/node");
    vi.spyOn(library, "Defuddle").mockImplementation(async (_document, _url, options) => {
      await expect(options!.fetch!(url)).rejects.toBe(failure);
      owner.abort(abort);
      throw new Error("Generic extraction failure");
    });
    await expect(
      extractContent(
        "<html><body>Fallback</body></html>",
        url,
        { url },
        async () => {
          throw failure;
        },
        owner.signal,
        "text/html",
      ),
    ).rejects.toBe(abort);
  });

  it("checks owner cancellation after asynchronous body consumption", async () => {
    const owner = new AbortController();
    const abort = new Error("Owner cancelled during body read");
    const response = new Response("{}");
    response.json = async () => {
      await Promise.resolve();
      owner.abort(abort);
      return {};
    };
    const library = await import("defuddle/node");
    vi.spyOn(library, "Defuddle").mockImplementation(async (_document, _url, options) => {
      const fetched = await options!.fetch!(url);
      await fetched.json(); // In-memory consumption is not intercepted; the owner is checked afterward.
      throw new Error("Generic extraction failure");
    });
    await expect(
      extractContent(
        "<html><body>Fallback</body></html>",
        url,
        { url },
        async () => response,
        owner.signal,
        "text/html",
      ),
    ).rejects.toBe(abort);
  });
});
