import { afterEach, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  type Api,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { searchCodex } from "./search.ts";

const model: Model<"openai-codex-responses"> = {
  id: "fake-codex",
  name: "Fake Codex",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 10000,
};

function setup(
  message = fauxAssistantMessage([fauxText("An answer.")]),
  searchStatus = "completed",
) {
  const usage = {
    input: 12,
    output: 8,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 22,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
  };
  message.usage = usage;
  let nativeSearch = true;
  const streamSimple = vi.fn(
    (_model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions) => ({
      async *[Symbol.asyncIterator]() {
        await options.onPayload?.(
          {
            input: context.messages,
            include: ["reasoning.encrypted_content"],
            tool_choice: "auto",
          },
          model,
        );
        if (nativeSearch)
          await options.onProviderStreamEvent?.(
            {
              type: "response.output_item.done",
              item: {
                type: "web_search_call",
                status: searchStatus,
                action: { sources: [{ title: "Source", url: "https://example.com/" }] },
              },
            },
            model,
          );
        yield {
          type: "text_delta" as const,
          contentIndex: 0,
          delta: "An answer.",
          partial: message,
        };
      },
      result: async () => message,
    }),
  );
  const ctx = {
    model,
    modelRegistry: { streamSimple },
    thinkingLevel: "high",
  } as unknown as ExtensionContext;
  return {
    ctx,
    streamSimple,
    usage,
    withoutSearch() {
      nativeSearch = false;
    },
  };
}

afterEach(() => vi.useRealTimers());

it("uses a fresh Codex context with native search, inherited reasoning, sources, and usage", async () => {
  const fixture = setup();
  const signal = new AbortController().signal;
  const update = vi.fn();
  const result = await searchCodex({ query: "  current news  " }, fixture.ctx, signal, update);
  expect(result.isError).toBeUndefined();
  expect(result.usage).toBe(fixture.usage);
  expect(result.details).toMatchObject({
    version: 1,
    model: "fake-codex",
    status: "done",
    searched: true,
    sources: [{ title: "Source", url: "https://example.com/" }],
  });
  expect(result.content[0]).toEqual({
    type: "text",
    text: "An answer.\n\nSources:\nhttps://example.com/",
  });
  const [selected, context, options] = fixture.streamSimple.mock.calls[0];
  expect(selected).toBe(model);
  expect(context.messages).toEqual([
    { role: "user", content: "current news", timestamp: expect.any(Number) },
  ]);
  expect(context.tools).toBeUndefined();
  expect(options.transport).toBe("sse");
  expect(options.reasoning).toBe("high");
  const payload = await options.onPayload?.(
    { tools: [{ type: "function" }], include: ["reasoning.encrypted_content"] },
    model,
  );
  expect(payload).toMatchObject({
    tools: [{ type: "web_search" }],
    tool_choice: "required",
    store: false,
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
  });
  expect(update).toHaveBeenCalledTimes(2);
  expect(update.mock.calls[0][0].details.status).toBe("searching");
  expect(update.mock.calls[1][0].details.status).toBe("answering");
});

it("rejects missing/non-Codex models, blank/oversized queries, and pre-aborted calls without requests", async () => {
  const fixture = setup();
  for (const selected of [
    undefined,
    { ...model, provider: "openai" },
    { ...model, api: "openai-responses" },
  ]) {
    const result = await searchCodex(
      { query: "news" },
      { ...fixture.ctx, model: selected },
      undefined,
    );
    expect(result.isError).toBe(true);
  }
  for (const query of [" ", "x".repeat(4001)])
    expect((await searchCodex({ query }, fixture.ctx, undefined)).isError).toBe(true);
  expect((await searchCodex({ query: "news" }, fixture.ctx, AbortSignal.abort())).isError).toBe(
    true,
  );
  expect(fixture.streamSimple).not.toHaveBeenCalled();
});

it.each(["failed", "in_progress"])(
  "does not claim success for a %s native search",
  async (status) => {
    const fixture = setup(fauxAssistantMessage([fauxText("An ordinary answer.")]), status);
    const result = await searchCodex({ query: "news" }, fixture.ctx, undefined);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("did not complete a native search");
    expect(result.usage).toBe(fixture.usage);
  },
);

it.each([
  ["error", "provider failure", "provider failure"],
  ["length", undefined, "Codex returned an incomplete search answer."],
  ["stop", undefined, "Codex returned an answer without a native search call."],
] as const)(
  "checks the %s response before later empty-answer validation",
  async (stopReason, errorMessage, expected) => {
    const fixture = setup(fauxAssistantMessage([], { stopReason, errorMessage }));
    fixture.withoutSearch();
    const result = await searchCodex({ query: "news" }, fixture.ctx, undefined);
    expect(result.content).toEqual([{ type: "text", text: `Error: ${expected}` }]);
    expect(result.isError).toBe(true);
  },
);

it("does not claim success when native search was skipped or the answer is empty", async () => {
  const fixture = setup();
  fixture.withoutSearch();
  expect((await searchCodex({ query: "news" }, fixture.ctx, undefined)).isError).toBe(true);
  const empty = setup(fauxAssistantMessage([]));
  expect((await searchCodex({ query: "news" }, empty.ctx, undefined)).isError).toBe(true);
});

it.each(["error", "aborted", "length", "toolUse"] as const)(
  "marks %s responses as errors and keeps their usage",
  async (stopReason) => {
    const fixture = setup(
      fauxAssistantMessage([fauxText("Partial answer")], { stopReason, errorMessage: "failure" }),
    );
    const result = await searchCodex({ query: "news" }, fixture.ctx, undefined);
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("error");
    expect(result.usage).toBe(fixture.usage);
    expect(JSON.stringify(result.content)).toContain("Partial answer");
  },
);

it("keeps legitimate source-free searches distinct from skipped searches", async () => {
  const fixture = setup();
  fixture.streamSimple.mockImplementation((_model, _context, options) => ({
    async *[Symbol.asyncIterator]() {
      await options.onProviderStreamEvent?.({ type: "response.web_search_call.completed" }, model);
      yield* []; // This response has no streamed text updates.
    },
    result: async () => fauxAssistantMessage([fauxText("No matching pages were found.")]),
  }));
  const result = await searchCodex({ query: "rare query" }, fixture.ctx, undefined);
  expect(result.isError).toBeUndefined();
  expect(result.details.sources).toEqual([]);
  expect(result.details.searched).toBe(true);
});

it("bounds model-facing and streaming output", async () => {
  const fixture = setup(fauxAssistantMessage([fauxText("long line\n".repeat(20000))]));
  const update = vi.fn();
  const result = await searchCodex({ query: "news" }, fixture.ctx, undefined, update);
  const content = result.content[0];
  expect(content.type).toBe("text");
  if (content.type !== "text") throw Error("Expected text");
  expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(50000);
  expect(content.text).toContain("Output truncated");
  expect(content.text.split("\n").length).toBeLessThanOrEqual(2000);
  expect(result.details.truncated).toBe(true);
  expect(Buffer.byteLength(update.mock.calls[1][0].content[0].text)).toBeLessThanOrEqual(50000);
});

it("cleans up deadlines on success and synchronous setup failure", async () => {
  vi.useFakeTimers();
  const fixture = setup();
  await searchCodex({ query: "news" }, fixture.ctx, undefined);
  expect(vi.getTimerCount()).toBe(0);
  fixture.streamSimple.mockImplementation(() => {
    throw Error("setup failed");
  });
  const result = await searchCodex({ query: "news" }, fixture.ctx, undefined);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("setup failed");
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["cancel", "timeout"] as const)(
  "passes %s to an in-flight provider and clears its deadline",
  async (reason) => {
    vi.useFakeTimers();
    const fixture = setup();
    const caller = new AbortController();
    fixture.streamSimple.mockImplementation((_model, _context, options) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        yield* []; // Cancellation ends the stream without text updates.
      },
      result: async () => fauxAssistantMessage([], { stopReason: "aborted" }),
    }));
    const pending = searchCodex({ query: "news" }, fixture.ctx, caller.signal);
    if (reason === "cancel") caller.abort();
    else await vi.advanceTimersByTimeAsync(120000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      reason === "cancel" ? "cancelled" : "timed out",
    );
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("cancels independent provider production and recovers usage if an update callback fails", async () => {
  vi.useFakeTimers();
  const fixture = setup();
  let providerSignal: AbortSignal | undefined;
  let final: Promise<ReturnType<typeof fauxAssistantMessage>> | undefined;
  fixture.streamSimple.mockImplementation((_model, _context, options) => {
    providerSignal = options.signal;
    final = new Promise((resolve) =>
      options.signal?.addEventListener(
        "abort",
        () => {
          const message = fauxAssistantMessage([], { stopReason: "aborted" });
          message.usage = fixture.usage;
          resolve(message);
        },
        { once: true },
      ),
    );
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "text_delta" as const,
          contentIndex: 0,
          delta: "partial",
          partial: fauxAssistantMessage([fauxText("partial")]),
        };
      },
      result: () => final!,
    };
  });
  const update = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw Error("update failed");
    });
  const result = await searchCodex({ query: "news" }, fixture.ctx, undefined, update);
  expect(providerSignal?.aborted).toBe(true);
  expect(result.isError).toBe(true);
  expect(result.usage).toBe(fixture.usage);
  expect(JSON.stringify(result.content)).toContain("update failed");
  expect(vi.getTimerCount()).toBe(0);
});

it("omits an explicit reasoning level when thinking is off", async () => {
  const fixture = setup();
  await searchCodex({ query: "news" }, { ...fixture.ctx, thinkingLevel: "off" }, undefined);
  expect(fixture.streamSimple.mock.calls[0][2].reasoning).toBeUndefined();
});
