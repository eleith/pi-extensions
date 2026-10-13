import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { RequestOwner, TransportError } from "./transport.js";
import type { NativeFetch, OpenResponse } from "./transport.js";

const owners: RequestOwner[] = [];
function owner(
  fetch?: NativeFetch,
  options: ConstructorParameters<typeof RequestOwner>[2] = {},
  signal?: AbortSignal,
) {
  const instance = new RequestOwner(
    { url: "http://a.test/start" },
    { signal },
    { fetch, ...options },
  );
  owners.push(instance);
  return instance;
}
function response(text = "ok", status = 200, headers: HeadersInit = {}): OpenResponse {
  return {
    url: "http://a.test/start",
    status,
    statusText: "OK",
    headers: new Headers(headers),
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
  };
}
function controlledBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return { body, cancel, controller };
}
const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
afterEach(async () => {
  await Promise.all(owners.splice(0).map((o) => o.dispose()));
  vi.restoreAllMocks();
});

describe("request lifecycle and accepted-data bounds", () => {
  it("invokes the actual reader cancel on pending read, and settles JS abort", async () => {
    const source = controlledBody();
    const acquire = vi.spyOn(source.body, "getReader");
    const signal = new AbortController();
    const request = owner(async () => ({ ...response(), body: source.body }), {}, signal.signal);
    const opened = await request.open("http://a.test/start");
    const reading = request.read(opened);
    await pause();
    expect(acquire).toHaveBeenCalledOnce();
    signal.abort();
    await expect(reading).rejects.toMatchObject({ code: "cancelled" });
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(() => source.controller.enqueue(new Uint8Array([1]))).toThrow();
  });

  it("calls body.cancel without acquiring a reader for an unused response", async () => {
    const source = controlledBody();
    const acquire = vi.spyOn(source.body, "getReader");
    const request = owner(async () => ({ ...response(), body: source.body }));
    await request.open("http://a.test/start");
    await request.dispose();
    await request.dispose();
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("discards a pending reader's late result after invoking that reader's cancel", async () => {
    let resolve!: (chunk: ReadableStreamReadResult<Uint8Array>) => void;
    const source = controlledBody();
    const actualReader = {
      read: vi.fn(
        () =>
          new Promise<ReadableStreamReadResult<Uint8Array>>((r) => {
            resolve = r;
          }),
      ),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    vi.spyOn(source.body, "getReader").mockReturnValue(
      actualReader as unknown as ReadableStreamDefaultReader<Uint8Array>,
    );
    const signal = new AbortController();
    const budget = { used: 0, limit: 10 };
    const request = owner(
      async () => ({ ...response(), body: source.body }),
      { budget },
      signal.signal,
    );
    const reading = request.read(await request.open("http://a.test/start"));
    await pause();
    signal.abort();
    await expect(reading).rejects.toMatchObject({ code: "cancelled" });
    expect(actualReader.cancel).toHaveBeenCalledOnce();
    resolve({ done: false, value: new Uint8Array([1, 2, 3]) });
    await pause();
    expect(budget.used).toBe(0);
    expect(actualReader.read).toHaveBeenCalledOnce();
  });

  it("does not start already-aborted work", async () => {
    const native = vi.fn(async () => response());
    const signal = new AbortController();
    signal.abort();
    await expect(
      owner(native, {}, signal.signal).open("http://a.test/start"),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(native).not.toHaveBeenCalled();
  });

  it("discards a late native response and cancels its actual body", async () => {
    let resolve!: (r: OpenResponse) => void;
    const native = vi.fn(
      () =>
        new Promise<OpenResponse>((r) => {
          resolve = r;
        }),
    );
    const signal = new AbortController();
    const request = owner(native, {}, signal.signal);
    const opening = request.open("http://a.test/start");
    await pause();
    signal.abort();
    await expect(opening).rejects.toMatchObject({ code: "cancelled" });
    const source = controlledBody();
    resolve({ ...response(), body: source.body });
    await pause();
    expect(source.cancel).toHaveBeenCalledOnce();
  });

  it("shares an absolute deadline across headers/body reads", async () => {
    const source = controlledBody();
    const request = owner(async () => ({ ...response(), body: source.body }), {
      deadlineAt: Date.now() + 30,
    });
    const opened = await request.open("http://a.test/start");
    await expect(request.read(opened)).rejects.toMatchObject({ code: "timeout" });
    expect(source.cancel).toHaveBeenCalledOnce();
  });

  it("combines extractor and owner signals", async () => {
    const source = controlledBody();
    const request = owner(async () => ({ ...response(), body: source.body }));
    const child = new AbortController();
    const fetching = request.fetch("http://a.test/api", { signal: child.signal });
    await pause();
    child.abort();
    await expect(fetching).rejects.toMatchObject({ code: "cancelled" });
    expect(source.cancel).toHaveBeenCalledOnce();
    request.check(); // child abort does not expire the entire context
  });

  it("enforces per-body bytes before decoding and cancels the overflowing reader", async () => {
    const source = controlledBody();
    const request = owner(async () => ({ ...response(), body: source.body }), {
      limits: { textBytes: 3 },
    });
    const opened = await request.open("http://a.test/start");
    const reading = request.read(opened);
    source.controller.enqueue(new Uint8Array([1, 2, 3, 4]));
    await expect(reading).rejects.toMatchObject({ code: "limit" });
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(() => request.check()).toThrow(TransportError);
  });

  it("decodes split UTF-8 without confusing characters with bytes", async () => {
    const bytes = new TextEncoder().encode("é😀");
    const native: NativeFetch = async () => ({
      ...response(),
      body: new ReadableStream({
        start(c) {
          for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
          c.close();
        },
      }),
    });
    const budget = { used: 0, limit: 6 };
    const request = owner(native, { budget, limits: { textBytes: 6 } });
    expect(await request.read(await request.open("http://a.test/start"))).toBe("é😀");
    expect(budget.used).toBe(6);
  });

  it("accounts replacement-character expansion against decoded/batch budgets", async () => {
    const native: NativeFetch = async () => ({
      ...response(),
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([255]));
          c.close();
        },
      }),
    });
    const budget = { used: 0, limit: 2 };
    const request = owner(native, { budget, limits: { textBytes: 10 } });
    await expect(request.read(await request.open("http://a.test/start"))).rejects.toMatchObject({
      code: "limit",
    });
    expect(budget.used).toBeLessThanOrEqual(2);
  });

  it("counts failed/secondary bodies cumulatively and shares batch budget across owners", async () => {
    const native: NativeFetch = async () => response("123", 404);
    const budget = { used: 0, limit: 5 };
    const first = owner(native, { budget });
    expect((await first.fetch("http://a.test/one")).status).toBe(404);
    const second = owner(native, { budget });
    await expect(second.fetch("http://a.test/two")).rejects.toMatchObject({ code: "limit" });
    expect(budget.used).toBe(3);
    const third = owner(native, { limits: { requestBytes: 5 } });
    await third.fetch("http://a.test/repeated");
    await expect(third.fetch("http://a.test/repeated")).rejects.toMatchObject({ code: "limit" });
  });

  it("classifies native failures without leaking native request values", async () => {
    const request = owner(async () => {
      throw new Error("Authorization: secret; proxy://password");
    });
    await expect(request.open("http://a.test/start")).rejects.toMatchObject({
      code: "network",
      message: "Web request failed.",
    });
  });

  it("cancels malformed and oversized header bodies", async () => {
    const source = controlledBody();
    const request = owner(async () => ({
      ...response(),
      headers: new Headers({ "x-large": "x".repeat(65537) }),
      body: source.body,
    }));
    await expect(request.open("http://a.test/start")).rejects.toMatchObject({ code: "limit" });
    expect(source.cancel).toHaveBeenCalledOnce();
    const second = controlledBody();
    const invalid = owner(async () => ({
      ...response(),
      headers: [["bad\nheader", "secret"]],
      body: second.body,
    }));
    await expect(invalid.open("http://a.test/start")).rejects.toMatchObject({ code: "network" });
    expect(second.cancel).toHaveBeenCalledOnce();
  });
});

describe("destinations, methods, and credential isolation", () => {
  it.each(["file:///etc/passwd", "ftp://a.test", "http://user:password@a.test", "not a url"])(
    "rejects %s without network",
    async (url) => {
      const native = vi.fn(async () => response());
      await expect(owner(native).open(url)).rejects.toMatchObject({ code: "invalid_request" });
      expect(native).not.toHaveBeenCalled();
    },
  );

  it.each([301, 302, 303, 307, 308])(
    "applies %s redirect method semantics and cancels unused body",
    async (status) => {
      const source = controlledBody();
      const native = vi
        .fn<NativeFetch>()
        .mockResolvedValueOnce({
          ...response("", status, { location: "/target" }),
          body: source.body,
        })
        .mockResolvedValueOnce(response());
      const request = owner(native);
      const opened = await request.open("http://a.test/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"x":1}',
      });
      expect(opened.url).toBe("http://a.test/target");
      const last = native.mock.calls[1][1];
      expect(last.method).toBe(status === 307 || status === 308 ? "POST" : "GET");
      expect(last.body).toBe(status === 307 || status === 308 ? '{"x":1}' : undefined);
      expect(source.cancel).toHaveBeenCalledOnce();
      expect(native.mock.calls[0][1]).toMatchObject({
        redirect: "manual",
        browser: "chrome_147",
        os: "windows",
      });
      await request.read(opened);
    },
  );

  it("permanently strips all origin-bound headers across origins including return", async () => {
    const native = vi
      .fn<NativeFetch>()
      .mockResolvedValueOnce(response("", 307, { location: "http://b.test/other" }))
      .mockResolvedValueOnce(response("", 307, { location: "http://a.test/return" }))
      .mockResolvedValueOnce(response());
    const request = owner(native);
    await request.read(
      await request.open("http://a.test/start", {
        headers: {
          authorization: "secret",
          cookie: "session=secret",
          "x-api-token": "secret",
          referer: "http://a.test/secret",
          accept: "site/type",
        },
      }),
    );
    const first = new Headers(native.mock.calls[0][1].headers as HeadersInit);
    expect(first.get("authorization")).toBe("secret");
    for (const call of native.mock.calls.slice(1)) {
      const headers = new Headers(call[1].headers as HeadersInit);
      for (const name of ["authorization", "cookie", "x-api-token", "referer"])
        expect(headers.has(name)).toBe(false);
      expect(headers.get("accept")).not.toBe("site/type");
      expect(headers.has("accept-language")).toBe(true);
    }
    const isolated = vi.fn<NativeFetch>(async () => response());
    const other = owner(isolated);
    await other.read(await other.open("http://a.test/start"));
    expect(
      new Headers(isolated.mock.calls[0]?.[1]?.headers as HeadersInit).has("authorization"),
    ).toBe(false);
  });

  it("rejects HTTPS downgrade and cancels the redirect body", async () => {
    const source = controlledBody();
    const request = owner(async () => ({
      ...response("", 302, { location: "http://a.test/insecure" }),
      body: source.body,
    }));
    await expect(request.open("https://a.test/start")).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(source.cancel).toHaveBeenCalledOnce();
  });

  it("shares traversal visited/hops across open calls, separate from repeated API POSTs", async () => {
    const request = owner(async () => response(), {
      limits: { maxHops: 1, maxSecondaryRequests: 2 },
    });
    await request.read(await request.open("http://a.test/start"));
    await request.fetch("http://a.test/api", { method: "POST", body: "{}" });
    await request.fetch("http://a.test/api", { method: "POST", body: "{}" });
    await request.read(await request.open("http://a.test/meta"));
    await expect(request.open("http://a.test/alternate")).rejects.toMatchObject({ code: "limit" });
    const repeated = owner(async () => response());
    await repeated.read(await repeated.open("http://a.test/start#one"));
    await expect(repeated.open("http://a.test/start#two")).rejects.toMatchObject({
      code: "extraction",
    });
    expect(repeated.signal.aborted).toBe(false);
    await repeated.read(await repeated.open("http://a.test/later"));
  });

  it("bounds redirects, secondary requests, and all network attempts", async () => {
    const looping = owner(async () => response("", 302, { location: "/start" }));
    await expect(looping.open("http://a.test/start")).rejects.toMatchObject({ code: "extraction" });
    expect(looping.signal.aborted).toBe(false);
    const secondary = owner(async () => response(), { limits: { maxSecondaryRequests: 1 } });
    await secondary.fetch("http://a.test/api");
    await expect(secondary.fetch("http://a.test/api")).rejects.toMatchObject({ code: "limit" });
    const all = owner(async () => response(), { limits: { maxRequests: 1 } });
    await all.fetch("http://a.test/api");
    await expect(all.open("http://a.test/start")).rejects.toMatchObject({ code: "limit" });
  });

  it.each([
    { method: "PUT" },
    { method: "HEAD" },
    { body: "get body" },
    { method: "POST", body: "not json" },
    { method: "POST", body: "{}", headers: { "content-type": "text/plain" } },
    { headers: { "proxy-authorization": "secret" } },
    { headers: { host: "fake.test" } },
  ])("rejects unsupported internal operations before networking: %j", async (init) => {
    const native = vi.fn(async () => response());
    await expect(
      owner(native).open("http://a.test/start", init as Parameters<RequestOwner["open"]>[1]),
    ).rejects.toBeInstanceOf(TransportError);
    expect(native).not.toHaveBeenCalled();
  });

  it("bounds internal header and body input", async () => {
    const native = vi.fn(async () => response());
    const request = owner(native);
    await expect(
      request.open("http://a.test/start", { headers: { "x-large": "x".repeat(8193) } }),
    ).rejects.toMatchObject({ code: "limit" });
    await expect(
      request.open("http://a.test/start", {
        method: "POST",
        body: JSON.stringify("x".repeat(65536)),
      }),
    ).rejects.toMatchObject({ code: "limit" });
    expect(native).not.toHaveBeenCalled();
  });
});

describe("controlled extractor fetch", () => {
  it.each([
    ["markdown", "text/markdown"],
    ["json", "application/json"],
    ["html", "text/html"],
    ["raw", "text/html"],
  ] as const)("generates internal negotiation headers for %s", async (format, accept) => {
    const native = vi.fn<NativeFetch>(async () => response());
    const request = new RequestOwner({ url: "http://a.test/start", format }, {}, { fetch: native });
    owners.push(request);
    await request.read(await request.open("http://a.test/start"));
    const headers = new Headers(native.mock.calls[0][1].headers as HeadersInit);
    expect(headers.get("accept")?.startsWith(accept)).toBe(true);
    expect(headers.get("accept-language")).toBe("en-US,en;q=0.9");
  });

  it("supports string, URL, Request, Headers, GET/text and JSON POST/JSON via real Response", async () => {
    const native = vi.fn<NativeFetch>(async () =>
      response('{"value":2}', 201, { "content-type": "application/json", "x-fixture": "yes" }),
    );
    const request = owner(native);
    const result = await request.fetch(
      new Request("http://a.test/api", {
        method: "POST",
        headers: new Headers({ "x-extractor": "fixture", "content-type": "application/json" }),
        body: '{"input":1}',
      }),
    );
    expect(result).toBeInstanceOf(Response);
    expect(result.url).toBe("http://a.test/api");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(201);
    expect(result.headers.get("x-fixture")).toBe("yes");
    expect(await result.json()).toEqual({ value: 2 });
    expect(native.mock.calls[0][1].body).toBe('{"input":1}');
    expect(new Headers(native.mock.calls[0][1].headers as HeadersInit).get("x-extractor")).toBe(
      "fixture",
    );
    expect(await (await request.fetch(new URL("http://a.test/api"))).text()).toBe('{"value":2}');
  });

  it("fails unsupported adapter options rather than falling through to global fetch", async () => {
    const fallback = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected global fetch"));
    const native = vi.fn(async () => response());
    const request = owner(native);
    await expect(request.fetch("http://a.test/api", { redirect: "follow" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      request.fetch("http://a.test/api", { method: "POST", body: new URLSearchParams() }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(native).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("accepts extractor credentials hints but creates no session/cookie jar", async () => {
    const native = vi.fn<NativeFetch>(async () => response());
    const request = owner(native);
    await request.fetch("http://a.test/api", { credentials: "include" });
    expect(native.mock.calls[0][1]).not.toHaveProperty("credentials");
    expect(native.mock.calls[0][1]).not.toHaveProperty("session");
  });
});

describe("real Defuddle extractors through the owner adapter (offline fixtures)", () => {
  const fixture = (name: string) =>
    readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

  it("routes YouTube JSON POST/player/chapter and caption GET through shared caps/signals", async () => {
    const { extractContent } = await import("./extract.ts");
    const trap = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected global fetch"));
    const payloads = new Map([
      [
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        await fixture("youtube-player.json"),
      ],
      [
        "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
        await fixture("youtube-next.json"),
      ],
      [
        "https://www.youtube.com/api/timedtext?v=fixture123",
        await fixture("youtube-transcript.xml"),
      ],
    ]);
    const native = vi.fn<NativeFetch>(async (url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (!url.includes("timedtext")) {
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string).videoId).toBe("fixture123");
        expect(new Headers(init.headers as HeadersInit).get("content-type")).toBe(
          "application/json",
        );
      }
      const payload = payloads.get(url);
      if (!payload) throw new Error("Unexpected fixture destination");
      return response(payload);
    });
    const budget = { used: 0, limit: 10000 };
    const request = owner(native, { budget });
    const url = "https://www.youtube.com/watch?v=fixture123";
    const result = await extractContent(
      await fixture("youtube.html"),
      url,
      { url },
      request.fetch,
      request.signal,
      "text/html",
    );
    expect(result.content).toContain("Welcome to an offline transcript fixture");
    expect(result.content).toContain("Fixture chapter");
    expect(native).toHaveBeenCalledTimes(3);
    expect(budget.used).toBe(
      [...payloads.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    );
    expect(trap).not.toHaveBeenCalled();
  });

  it("routes Reddit status/URL/text fallback through the buffered real Response", async () => {
    const { extractContent } = await import("./extract.ts");
    const trap = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected global fetch"));
    const feed = await fixture("reddit-feed.xml");
    const native = vi.fn<NativeFetch>(async (url, init) => {
      const headers = new Headers(init.headers as HeadersInit);
      expect(headers.get("user-agent")).toContain("defuddle");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (url === "https://old.reddit.com/r/fixtures/comments/feedfixture/offline")
        return response("blocked", 403);
      expect(url).toBe("https://www.reddit.com/r/fixtures/comments/feedfixture/offline/.rss");
      expect(headers.get("accept")).toContain("application/atom+xml");
      return response(feed);
    });
    const request = owner(native);
    const url = "https://www.reddit.com/r/fixtures/comments/feedfixture/offline";
    const result = await extractContent(
      "<html><body></body></html>",
      url,
      { url },
      request.fetch,
      request.signal,
      "text/html",
    );
    expect(result.content).toContain("Atom post body");
    expect(result.content).toContain("Atom reply fixture content");
    expect(native).toHaveBeenCalledTimes(2);
    expect(trap).not.toHaveBeenCalled();
  });

  it("routes X JSON and oEmbed fallback with no shared credentials/global fallback", async () => {
    const { extractContent } = await import("./extract.ts");
    const trap = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected global fetch"));
    const oembed = await fixture("x-oembed.json");
    const native = vi.fn<NativeFetch>(async (url, init) => {
      if (url === "https://api.fxtwitter.com/fixture/status/12345") {
        expect(new Headers(init.headers as HeadersInit).get("user-agent")).toContain("Defuddle");
        return response("blocked", 404);
      }
      expect(url).toBe(
        "https://publish.twitter.com/oembed?url=https%3A%2F%2Fx.com%2Ffixture%2Fstatus%2F12345&omit_script=true",
      );
      expect(new Headers(init.headers as HeadersInit).has("user-agent")).toBe(false);
      return response(oembed);
    });
    const request = owner(native);
    const url = "https://x.com/fixture/status/12345";
    const before = console.error;
    const result = await extractContent(
      "<html><body></body></html>",
      url,
      { url },
      request.fetch,
      request.signal,
      "text/html",
    );
    expect(result.content).toContain("offline oEmbed tweet");
    expect(result.author).toBe("@fixture");
    expect(native).toHaveBeenCalledTimes(2);
    expect(trap).not.toHaveBeenCalled();
    expect(console.error).toBe(before);
  });
});

describe("extension-wide admission (active JS attempts, not native lifetime)", () => {
  it.each([
    { name: "invalid status", status: 199, headers: [], code: "network" },
    { name: "invalid headers", status: 200, headers: [["bad\nheader", "secret"]], code: "network" },
    {
      name: "oversized headers",
      status: 200,
      headers: [["x-large", "x".repeat(65537)]],
      code: "limit",
    },
  ])("cancels the body and releases admission after $name", async ({ status, headers, code }) => {
    const native = vi.fn<NativeFetch>(async () => ({ ...response(), body: controlledBody().body }));
    const holding = Array.from({ length: 7 }, () => owner(native));
    await Promise.all(holding.map((request) => request.open("http://a.test/start")));

    const source = controlledBody();
    let resolve!: (value: Awaited<ReturnType<NativeFetch>>) => void;
    const invalidNative = vi.fn<NativeFetch>(
      () =>
        new Promise((settle) => {
          resolve = settle;
        }),
    );
    const invalidOwner = owner(invalidNative);
    const opening = invalidOwner.open("http://a.test/invalid");
    const rejected = expect(opening).rejects.toMatchObject({ code });
    await pause();
    expect(invalidNative).toHaveBeenCalledOnce();

    const waitingOwner = owner(native);
    const waiting = waitingOwner.open("http://a.test/waiting");
    await pause();
    expect(native).toHaveBeenCalledTimes(7);
    resolve({ ...response(), status, headers: headers as [string, string][], body: source.body });
    await rejected;
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(invalidOwner.signal.aborted).toBe(code === "limit");
    waitingOwner.cancel(await waiting);
    expect(native).toHaveBeenCalledTimes(8);
  });

  it("holds eight slots until body consumption/cancellation, aborts queued work, and starts deadline before admission", async () => {
    const native = vi.fn<NativeFetch>(async () => ({ ...response(), body: controlledBody().body }));
    const requests = Array.from({ length: 8 }, () => owner(native));
    const opened = await Promise.all(requests.map((r) => r.open("http://a.test/start")));
    const child = new AbortController();
    const queued = owner(native, {}, child.signal).open("http://a.test/queued");
    await pause();
    expect(native).toHaveBeenCalledTimes(8);
    child.abort();
    await expect(queued).rejects.toMatchObject({ code: "cancelled" });
    const timed = owner(native, { deadlineAt: Date.now() + 15 }).open("http://a.test/timed");
    await expect(timed).rejects.toMatchObject({ code: "timeout" });
    expect(native).toHaveBeenCalledTimes(8);
    const waitingOwner = owner(native);
    const waiting = waitingOwner.open("http://a.test/waiting");
    await pause();
    expect(native).toHaveBeenCalledTimes(8);
    requests[0].cancel(opened[0]);
    const next = await waiting;
    expect(native).toHaveBeenCalledTimes(9);
    waitingOwner.cancel(next);
  });

  it("bounds pending admission to 96 without starting excess work", async () => {
    const native = vi.fn<NativeFetch>(async () => ({ ...response(), body: controlledBody().body }));
    const requests = Array.from({ length: 8 }, () => owner(native));
    await Promise.all(requests.map((r) => r.open("http://a.test/start")));
    const queuedOwners = Array.from({ length: 96 }, () => owner(native));
    const queued = queuedOwners.map((r) => r.open("http://a.test/queued").catch((error) => error));
    await pause();
    await expect(owner(native).open("http://a.test/excess")).rejects.toMatchObject({
      code: "limit",
    });
    expect(native).toHaveBeenCalledTimes(8);
    await Promise.all(queuedOwners.map((r) => r.dispose()));
    expect((await Promise.all(queued)).every((error) => error.code === "cancelled")).toBe(true);
  });
});

async function localServer(
  handler: (
    url: string,
    headers: import("node:http").IncomingHttpHeaders,
    response: ServerResponse,
  ) => void,
) {
  const server = createServer((req, res) => handler(req.url!, req.headers, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("real wreq-js 3.2 local fixtures", () => {
  it("uses supported profile and reads decoded gzip data with no shared cookies", async () => {
    const { getProfiles } = await import("wreq-js");
    expect(getProfiles()).toContain("chrome_147");
    const cookies: Array<string | undefined> = [];
    const fixture = await localServer((_url, headers, res) => {
      cookies.push(headers.cookie);
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-encoding": "gzip",
        "set-cookie": "native_fixture=secret",
      });
      res.end(gzipSync("é😀 fixture"));
    });
    try {
      for (let i = 0; i < 2; i++) {
        const request = owner();
        expect(await request.read(await request.open(fixture.url))).toBe("é😀 fixture");
      }
      expect(cookies).toEqual([undefined, undefined]);
    } finally {
      await close(fixture.server);
    }
  });

  it("manually follows local redirects with actual cross-origin stripping", async () => {
    const seen: Array<{ url: string; headers: import("node:http").IncomingHttpHeaders }> = [];
    const target = await localServer((url, headers, res) => {
      seen.push({ url, headers });
      res.end("target");
    });
    const source = await localServer((_url, _headers, res) => {
      res.writeHead(302, { location: target.url + "/target" });
      res.end("unused");
    });
    try {
      const request = owner();
      const opened = await request.open(source.url, {
        headers: {
          authorization: "fixture-secret",
          cookie: "fixture=secret",
          "x-api-key": "fixture-secret",
        },
      });
      expect(opened.url).toBe(target.url + "/target");
      expect(await request.read(opened)).toBe("target");
      expect(seen).toHaveLength(1);
      for (const key of ["authorization", "cookie", "x-api-key"])
        expect(seen[0].headers[key]).toBeUndefined();
    } finally {
      await close(source.server);
      await close(target.server);
    }
  });

  it("aborts local native streaming promptly in JS without asserting immediate socket closure", async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const fixture = await localServer((_url, _headers, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first");
      timer = setInterval(() => res.write("later"), 10);
      res.on("close", () => clearInterval(timer));
    });
    try {
      const signal = new AbortController();
      const request = owner(undefined, {}, signal.signal);
      const opened = await request.open(fixture.url);
      const reading = request.read(opened);
      await pause(25);
      signal.abort();
      await expect(reading).rejects.toMatchObject({ code: "cancelled" });
      // Native stream may remain active: the retained diagnostic records that limitation.
    } finally {
      clearInterval(timer);
      await close(fixture.server);
    }
  });

  it("settles abort before native headers without treating it as a native lifetime guarantee", async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fixture = await localServer((_url, _headers, res) => {
      timer = setTimeout(() => res.end("late"), 100);
    });
    try {
      const signal = new AbortController();
      const request = owner(undefined, {}, signal.signal);
      const opening = request.open(fixture.url);
      await pause(10);
      signal.abort();
      await expect(opening).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      clearTimeout(timer);
      await close(fixture.server);
    }
  });

  it("classifies an early disconnected native body without leaking the native diagnostic", async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fixture = await localServer((_url, _headers, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("partial");
      timer = setTimeout(() => res.destroy(), 10);
    });
    try {
      const request = owner();
      await expect(
        (async () => request.read(await request.open(fixture.url)))(),
      ).rejects.toMatchObject({ code: "network" });
    } finally {
      clearTimeout(timer);
      await close(fixture.server);
    }
  });

  it("caps decompressed accepted bytes, not compressed wire bytes", async () => {
    const fixture = await localServer((_url, _headers, res) => {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(gzipSync("x".repeat(1000)));
    });
    try {
      const request = owner(undefined, { limits: { textBytes: 50 } });
      await expect(request.read(await request.open(fixture.url))).rejects.toMatchObject({
        code: "limit",
      });
    } finally {
      await close(fixture.server);
    }
  });
});
