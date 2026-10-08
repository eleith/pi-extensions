import {
  createModels,
  createProvider,
  type Api,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { searchCodex } from "./search.ts";

/** Real public Pi provider + authentication + SSE adapter, with a fake HTTP response. */
function protocol(events: unknown[]) {
  const model: Model<"openai-codex-responses"> = {
    id: "fake-codex",
    name: "Fake Codex",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 10000,
  };
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } })).toString("base64")}.signature`;
  const resolveAuth = vi.fn(async () => ({ auth: { apiKey: token } }));
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "openai-codex",
      models: [model],
      auth: { apiKey: { name: "Fake credentials", resolve: resolveAuth } },
      api: openAICodexResponsesApi(),
    }),
  );
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
  const request = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 31)
              controller.enqueue(bytes.slice(offset, offset + 31));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  let payload: unknown;
  const ctx = {
    model,
    thinkingLevel: "low",
    modelRegistry: {
      streamSimple(selected: Model<Api>, context: Context, options: ModelsSimpleStreamOptions) {
        return models.streamSimple(selected, context, {
          ...options,
          fetch: request,
          maxRetries: 0,
          onPayload: async (body, current) => {
            payload = await options.onPayload?.(body, current);
            return payload;
          },
        });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, request, resolveAuth, payload: () => payload };
}

const source = { title: "Pi", url: "https://pi.dev/" };
const item = {
  type: "message",
  id: "message-1",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: "Pi is a coding agent.",
      annotations: [{ type: "url_citation", ...source }],
    },
  ],
};
const search = {
  type: "web_search_call",
  id: "search-1",
  status: "completed",
  action: { type: "search", query: "Pi", sources: [source] },
};

it("enables real native search through Pi, observes citations, and accounts for response usage", async () => {
  const fixture = protocol([
    { type: "response.created", response: { id: "response-1" } },
    { type: "response.web_search_call.searching", item_id: "search-1" },
    { type: "response.output_item.done", output_index: 0, item: search },
    { type: "response.output_item.added", output_index: 1, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 1, delta: "Pi is a coding agent." },
    {
      type: "response.output_text.annotation.added",
      output_index: 1,
      annotation: { type: "url_citation", ...source },
    },
    { type: "response.output_item.done", output_index: 1, item },
    {
      type: "response.completed",
      response: {
        id: "response-1",
        status: "completed",
        output: [search, item],
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          total_tokens: 30,
          input_tokens_details: { cached_tokens: 5 },
        },
      },
    },
  ]);
  const update = vi.fn();
  const result = await searchCodex({ query: "Pi" }, fixture.ctx, undefined, update);
  expect(result.isError, JSON.stringify(result)).toBeUndefined();
  expect(result.details.sources).toEqual([source]);
  expect(result.content).toEqual([
    { type: "text", text: "Pi is a coding agent.\n\nSources:\nhttps://pi.dev/" },
  ]);
  expect(result.usage).toMatchObject({ input: 15, output: 10, cacheRead: 5, totalTokens: 30 });
  expect(result.usage?.cost.total).toBeGreaterThan(0);
  expect(fixture.resolveAuth).toHaveBeenCalledOnce();
  expect(fixture.request).toHaveBeenCalledOnce();
  const [url, init] = fixture.request.mock.calls[0];
  expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("fake-account");
  expect(fixture.payload()).toMatchObject({
    tools: [{ type: "web_search" }],
    tool_choice: "required",
    reasoning: { effort: "low" },
    include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
    store: false,
  });
  expect(update.mock.calls.some(([result]) => result.details.status === "answering")).toBe(true);
});

it("rejects a truncated SSE stream instead of displaying a successful result", async () => {
  const fixture = protocol([
    { type: "response.output_item.done", output_index: 0, item: search },
    { type: "response.output_item.added", output_index: 1, item },
    { type: "response.output_text.delta", output_index: 1, delta: "partial answer" },
  ]);
  const result = await searchCodex({ query: "Pi" }, fixture.ctx, undefined);
  expect(result.isError).toBe(true);
  expect(result.details.status).toBe("error");
});

it.each(["failed", "in_progress"])(
  "rejects a %s search even when the answer stream completes normally",
  async (status) => {
    const call = { ...search, status };
    const fixture = protocol([
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.output_item.done", output_index: 1, item },
      { type: "response.completed", response: { status: "completed", output: [call, item] } },
    ]);
    const result = await searchCodex({ query: "Pi" }, fixture.ctx, undefined);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("did not complete a native search");
  },
);

it("reports provider failures through Pi's normalized error result", async () => {
  const fixture = protocol([
    {
      type: "response.failed",
      response: { status: "failed", error: { code: "rate_limit", message: "Usage limit reached" } },
    },
  ]);
  const result = await searchCodex({ query: "Pi" }, fixture.ctx, undefined);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("Usage limit reached");
});
