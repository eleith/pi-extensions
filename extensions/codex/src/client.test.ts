import type { Api, AuthResult, Model } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { fetchCodexUsage, type CodexAccountRegistry } from "./client.ts";

const BASE_URL = "https://chatgpt.com/backend-api";
const model: Model<Api> = {
  id: "gpt-6-sol",
  name: "Sol",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: BASE_URL,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
};

function token(account = "test-account"): string {
  const payload = { "https://api.openai.com/auth": { chatgpt_account_id: account } };
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fake-signature`;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const auth: AuthResult = { source: "OAuth", auth: { apiKey: token() } };
  const provider = { baseUrl: BASE_URL, getModels: () => [model] };
  const registry = {
    getProvider: vi.fn<CodexAccountRegistry["getProvider"]>(() => provider),
    getProviderAuth: vi.fn<CodexAccountRegistry["getProviderAuth"]>(async () => auth),
    isUsingOAuth: vi.fn<CodexAccountRegistry["isUsingOAuth"]>(() => true),
  };
  const fetcher = vi.fn<typeof fetch>(async () => json({ plan_type: "plus" }));
  return { registry, provider, auth, fetcher };
}

afterEach(() => {
  vi.useRealTimers();
});

it("uses Pi's existing Codex auth for the fixed account endpoint", async () => {
  const f = fixture();
  f.auth.auth.headers = { "X-Unrelated-Secret": "must-not-forward" };
  expect(await fetchCodexUsage(f.registry, undefined, f.fetcher)).toEqual({ plan_type: "plus" });
  expect(f.registry.getProviderAuth).toHaveBeenCalledExactlyOnceWith("openai-codex");
  expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(
    `${BASE_URL}/wham/usage`,
    expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) }),
  );
  const headers = new Headers(f.fetcher.mock.calls[0][1]?.headers);
  expect(Object.fromEntries(headers)).toEqual({
    accept: "application/json",
    authorization: `Bearer ${f.auth.auth.apiKey}`,
    "chatgpt-account-id": "test-account",
  });
});

it("derives the account from the token like Pi's legacy Codex transport", async () => {
  const f = fixture();
  f.auth.auth.headers = { "ChatGPT-Account-Id": "selected-account" };
  await fetchCodexUsage(f.registry, undefined, f.fetcher);
  const headers = new Headers(f.fetcher.mock.calls[0][1]?.headers);
  expect(headers.get("chatgpt-account-id")).toBe("test-account");
});

it("resolves auth afresh rather than retaining another account's credentials", async () => {
  const f = fixture();
  f.registry.getProviderAuth
    .mockResolvedValueOnce({ source: "OAuth", auth: { apiKey: token("first") } })
    .mockResolvedValueOnce({ source: "OAuth", auth: { apiKey: token("second") } });
  await fetchCodexUsage(f.registry, undefined, f.fetcher);
  await fetchCodexUsage(f.registry, undefined, f.fetcher);
  const accounts = f.fetcher.mock.calls.map(([, init]) =>
    new Headers(init?.headers).get("chatgpt-account-id"),
  );
  expect(accounts).toEqual(["first", "second"]);
});

it.each(["provider endpoint", "model endpoint", "auth endpoint"] as const)(
  "does not send credentials for an unsupported %s configuration",
  async (configuration) => {
    const f = fixture();
    if (configuration === "provider endpoint") f.provider.baseUrl = "https://gateway.invalid";
    if (configuration === "model endpoint") {
      f.provider.getModels = () => [{ ...model, baseUrl: "https://gateway.invalid" }];
    }
    if (configuration === "auth endpoint") f.auth.auth.baseUrl = "https://gateway.invalid";
    await expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);

it("requires Pi's Codex OAuth login rather than API-key authentication", async () => {
  const f = fixture();
  f.registry.isUsingOAuth.mockReturnValue(false);
  await expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "auth",
  });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it.each([
  { label: "opaque", key: "opaque-api-key" },
  { label: "token-shaped", key: token() },
])("rejects resolved $label API keys even if Pi's OAuth snapshot is stale", async ({ key }) => {
  const f = fixture();
  f.auth.source = "models.json";
  f.auth.auth.apiKey = key;
  f.auth.auth.headers = { "ChatGPT-Account-Id": "stale-account" };
  await expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "auth",
  });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("rechecks the endpoint after Pi finishes resolving credentials", async () => {
  const f = fixture();
  const auth = deferred<AuthResult>();
  f.registry.getProviderAuth.mockReturnValue(auth.promise);
  const request = fetchCodexUsage(f.registry, undefined, f.fetcher);
  f.provider.baseUrl = "https://gateway.invalid";
  auth.resolve(f.auth);
  await expect(request).rejects.toMatchObject({ code: "unsupported" });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("does not fetch or expose Pi's raw authentication errors", async () => {
  const f = fixture();
  f.registry.getProviderAuth.mockRejectedValue(new Error("private token refresh details"));
  await expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "auth",
    message: "Codex account access is unavailable. Check your Pi Codex login.",
  });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it.each([
  undefined,
  { source: "OAuth", auth: {} },
  { source: "OAuth", auth: { apiKey: "not-a-codex-token" } },
])("rejects missing or unusable auth without a request: %j", async (auth) => {
  const f = fixture();
  f.registry.getProviderAuth.mockResolvedValue(auth);
  await expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "auth",
  });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("does not expose transport error details", async () => {
  const f = fixture();
  f.fetcher.mockRejectedValue(new Error("Authorization: Bearer secret"));
  await expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "network",
    message: "Could not reach the Codex account service.",
  });
});

it.each([401, 403])("reports HTTP %s without exposing the server's error body", async (status) => {
  const f = fixture();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  f.fetcher.mockResolvedValue(new Response(body, { status }));
  await expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "auth",
    message: "Codex account access is unavailable. Check your Pi Codex login.",
  });
  expect(cancel).toHaveBeenCalledOnce();
});

it("returns retry-after information without automatically retrying", async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(
    new Response("private error", { status: 429, headers: { "Retry-After": "60" } }),
  );
  await expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "http",
    message: "Codex account service is rate limited.",
    retryAfterMs: 60_000,
  });
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it("does not follow or display a redirected endpoint", async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(
    new Response(null, { status: 302, headers: { Location: "https://other.invalid/private" } }),
  );
  await expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "http",
    message: "Codex account request failed (HTTP 302).",
  });
  expect(f.fetcher.mock.calls[0][1]?.redirect).toBe("error");
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it("cancels a chunked response before retaining more than the byte limit", async () => {
  const f = fixture();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel,
  });
  f.fetcher.mockResolvedValue(new Response(body));
  await expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "response",
    message: "Codex account response was too large.",
  });
  expect(cancel).toHaveBeenCalledOnce();
});

it("reports invalid JSON without repeating returned content", async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(new Response("<html>private server details</html>"));
  await expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "response",
    message: "Codex account service returned invalid JSON.",
  });
});

it("cancels during handoff of an already-buffered response", async () => {
  const f = fixture();
  const started = deferred<void>();
  const incoming = deferred<Response>();
  const controller = new AbortController();
  const response = json({ plan_type: "plus" });
  const discard = vi.spyOn(response.body!, "cancel");
  f.fetcher.mockImplementation(() => {
    started.resolve();
    return incoming.promise;
  });
  const request = fetchCodexUsage(f.registry, controller.signal, f.fetcher);
  await started.promise;
  incoming.resolve(response);
  queueMicrotask(() => controller.abort());
  await expect(request).rejects.toMatchObject({ code: "cancelled" });
  expect(discard).toHaveBeenCalledOnce();
});

it("cancels before auth resolution if the caller is already aborted", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(fetchCodexUsage(f.registry, controller.signal, f.fetcher)).rejects.toMatchObject({
    code: "cancelled",
  });
  expect(f.registry.getProviderAuth).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("ignores auth that resolves after the caller cancels", async () => {
  const f = fixture();
  const auth = deferred<AuthResult>();
  f.registry.getProviderAuth.mockReturnValue(auth.promise);
  const controller = new AbortController();
  const request = fetchCodexUsage(f.registry, controller.signal, f.fetcher);
  controller.abort();
  await expect(request).rejects.toMatchObject({ code: "cancelled" });
  auth.resolve(f.auth);
  await auth.promise;
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("discards a response arriving after cancellation even if fetch ignores the signal", async () => {
  const f = fixture();
  const started = deferred<void>();
  const response = deferred<Response>();
  const discarded = deferred<void>();
  f.fetcher.mockImplementation(() => {
    started.resolve();
    return response.promise;
  });
  const controller = new AbortController();
  const request = fetchCodexUsage(f.registry, controller.signal, f.fetcher);
  await started.promise;
  controller.abort();
  await expect(request).rejects.toMatchObject({ code: "cancelled" });
  response.resolve(new Response(new ReadableStream({ cancel: () => discarded.resolve() })));
  await discarded.promise;
});

it("bounds the wait for Pi's refresh without taking over refresh cancellation", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.registry.getProviderAuth.mockReturnValue(new Promise(() => {}));
  const result = expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "timeout",
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await result;
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds the wait for response headers", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.fetcher.mockReturnValue(new Promise(() => {}));
  const result = expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "timeout",
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await result;
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the deadline active while consuming the response body", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const cancel = vi.fn();
  f.fetcher.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel })));
  const result = expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "timeout",
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await result;
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
