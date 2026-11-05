import type { Api, AuthResult, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCodexModelCatalog, fetchCodexUsage, type CodexAccountRegistry } from "./client.ts";

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

it("returns raw catalog JSON using only Pi's resolved routing credentials", async () => {
  const f = fixture();
  f.auth.auth.headers = {
    "ChatGPT-Account-Id": "unused-account",
    Authorization: "unused-token",
    "X-Unrelated-Secret": "unused-secret",
  };
  const catalog = { models: [{ slug: "future-model", service_tiers: [{ id: "priority" }] }] };
  const response = json(catalog);
  f.fetcher.mockResolvedValue(response);
  const result = await fetchCodexModelCatalog(f.registry, undefined, f.fetcher);
  expect(result).toEqual(catalog);
  expect(f.registry.getProviderAuth).toHaveBeenCalledExactlyOnceWith("openai-codex");
  const requestOptions = expect.objectContaining({ method: "GET", redirect: "error" });
  expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(
    `${BASE_URL}/codex/models?client_version=0.162.0`,
    requestOptions,
  );
  const headers = new Headers(f.fetcher.mock.calls[0][1]?.headers);
  const actualHeaders = Object.fromEntries(headers);
  expect(actualHeaders).toEqual({
    accept: "application/json",
    authorization: `Bearer ${f.auth.auth.apiKey}`,
    "chatgpt-account-id": "test-account",
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(f.auth.auth.apiKey);
  expect(serialized).not.toContain("test-account");
});

it.each(["token refresh", "account change"] as const)(
  "resolves fresh catalog credentials after %s",
  async (change) => {
    const f = fixture();
    const originalToken = f.auth.auth.apiKey;
    await fetchCodexModelCatalog(f.registry, undefined, f.fetcher);
    const nextAccount = change === "token refresh" ? "test-account" : "another-account";
    const nextToken =
      change === "token refresh" ? `${originalToken}-refreshed` : token(nextAccount);
    f.auth.auth.apiKey = nextToken;
    await fetchCodexModelCatalog(f.registry, undefined, f.fetcher);
    const credentials = f.fetcher.mock.calls.map(([, init]) => {
      const headers = new Headers(init?.headers);
      return {
        authorization: headers.get("authorization"),
        account: headers.get("chatgpt-account-id"),
      };
    });
    expect(credentials).toEqual([
      { authorization: `Bearer ${originalToken}`, account: "test-account" },
      { authorization: `Bearer ${nextToken}`, account: nextAccount },
    ]);
    expect(f.registry.getProviderAuth).toHaveBeenCalledTimes(2);
  },
);

describe("catalog credential validation before HTTP", () => {
  const unexpectedFetch = vi.fn<typeof fetch>(async () => {
    throw new Error("must not fetch");
  });
  beforeEach(() => {
    unexpectedFetch.mockClear();
    vi.stubGlobal("fetch", unexpectedFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });
  const unavailableAuth = {
    code: "auth",
    message: "Codex account access is unavailable. Check your Pi Codex login.",
  };
  const unsupportedProvider = {
    code: "unsupported",
    message: "Account requests require the official Codex provider.",
  };

  it("rejects an overridden provider endpoint", async () => {
    const account = fixture();
    account.provider.baseUrl = "https://gateway.invalid";
    const request = fetchCodexModelCatalog(account.registry);
    await expect(request).rejects.toMatchObject(unsupportedProvider);
  });

  it("rejects a catalog model at a different endpoint", async () => {
    const account = fixture();
    account.provider.getModels = () => [{ ...model, baseUrl: "https://gateway.invalid" }];
    const request = fetchCodexModelCatalog(account.registry);
    await expect(request).rejects.toMatchObject(unsupportedProvider);
  });

  it("rejects an endpoint override in resolved credentials", async () => {
    const account = fixture();
    account.auth.auth.baseUrl = "https://gateway.invalid";
    const request = fetchCodexModelCatalog(account.registry);
    await expect(request).rejects.toMatchObject({
      code: "unsupported",
      message: "Account requests do not support endpoint overrides.",
    });
  });

  it("requires an OAuth availability snapshot", async () => {
    const account = fixture();
    account.registry.isUsingOAuth.mockReturnValue(false);
    const request = fetchCodexModelCatalog(account.registry);
    await expect(request).rejects.toMatchObject(unavailableAuth);
  });

  it("rejects a non-OAuth resolution even when the snapshot says OAuth", async () => {
    const account = fixture();
    account.auth.source = "models.json";
    const request = fetchCodexModelCatalog(account.registry);
    await expect(request).rejects.toMatchObject(unavailableAuth);
  });

  it("requires the token's account-routing claim", async () => {
    const account = fixture();
    account.auth.auth.apiKey = "e30.e30.private-token";
    const request = fetchCodexModelCatalog(account.registry);
    await expect(request).rejects.toMatchObject(unavailableAuth);
  });

  it("does not repeat private Pi refresh errors", async () => {
    const account = fixture();
    const refreshError = new Error("private refresh details");
    account.registry.getProviderAuth.mockRejectedValue(refreshError);
    const request = fetchCodexModelCatalog(account.registry);
    await expect(request).rejects.toMatchObject(unavailableAuth);
  });
});

it("does not forward catalog credentials through an endpoint override", async () => {
  const f = fixture();
  f.auth.auth.baseUrl = "https://gateway.invalid";
  await expect(fetchCodexModelCatalog(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "unsupported",
  });
  expect(f.fetcher).not.toHaveBeenCalled();
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

it.each([
  { label: "seconds", header: "60", retryAfterMs: 60_000 },
  { label: "zero seconds", header: "0", retryAfterMs: 0 },
  { label: "fractional seconds", header: "1.5", retryAfterMs: 1500 },
  { label: "numeric exponent notation", header: "1e1", retryAfterMs: 10_000 },
  { label: "a future HTTP date", header: "Wed, 02 Jan 2030 03:05:05 GMT", retryAfterMs: 60_000 },
  { label: "the current HTTP date", header: "Wed, 02 Jan 2030 03:04:05 GMT", retryAfterMs: 0 },
  { label: "a past HTTP date", header: "Wed, 02 Jan 2030 03:03:05 GMT", retryAfterMs: undefined },
  { label: "a malformed value", header: "later", retryAfterMs: undefined },
  { label: "negative seconds", header: "-1", retryAfterMs: undefined },
  { label: "a non-finite value", header: "Infinity", retryAfterMs: undefined },
  { label: "an empty header", header: "", retryAfterMs: undefined },
  { label: "a missing header", header: null, retryAfterMs: undefined },
])(
  "reports Retry-After with $label without automatically retrying",
  async ({ header, retryAfterMs }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-02T03:04:05Z"));
    const account = fixture();
    const headers = new Headers();
    if (header !== null) headers.set("Retry-After", header);
    const response = new Response("private error", { status: 429, headers });
    const discard = vi.spyOn(response.body!, "cancel");
    account.fetcher.mockResolvedValue(response);

    await expect(
      fetchCodexUsage(account.registry, undefined, account.fetcher),
    ).rejects.toMatchObject({
      code: "http",
      message: "Codex account service is rate limited.",
      retryAfterMs,
    });
    expect(account.fetcher).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
  },
);

it("returns the catalog's HTTP-date retry delay without retrying or exposing its body", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-02T03:04:05Z"));
  const account = fixture();
  const response = new Response("private catalog error", {
    status: 429,
    headers: { "Retry-After": "Wed, 02 Jan 2030 03:05:05 GMT" },
  });
  const discard = vi.spyOn(response.body!, "cancel");
  account.fetcher.mockResolvedValue(response);

  await expect(
    fetchCodexModelCatalog(account.registry, undefined, account.fetcher),
  ).rejects.toMatchObject({
    code: "http",
    message: "Codex account service is rate limited.",
    retryAfterMs: 60_000,
  });
  expect(account.fetcher).toHaveBeenCalledOnce();
  expect(discard).toHaveBeenCalledOnce();
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

it.each([
  ["usage", fetchCodexUsage],
  ["catalog", fetchCodexModelCatalog],
] as const)(
  "bounds chunked %s responses before retaining more than the byte limit",
  async (_resource, fetchData) => {
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
    await expect(fetchData(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
      code: "response",
      message: "Codex account response was too large.",
    });
    expect(cancel).toHaveBeenCalledOnce();
  },
);

it("reports invalid JSON without repeating returned content", async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(new Response("<html>private server details</html>"));
  await expect(fetchCodexUsage(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
    code: "response",
    message: "Codex account service returned invalid JSON.",
  });
});

it.each([
  ["usage", fetchCodexUsage],
  ["catalog", fetchCodexModelCatalog],
] as const)("cancels during the public %s wrapper handoff", async (_resource, fetchData) => {
  const f = fixture();
  const controller = new AbortController();
  const abort = AbortController.prototype.abort;
  // The private flow aborts its deadline in finally, immediately before handing off.
  const cleanup = vi.spyOn(AbortController.prototype, "abort").mockImplementation(function (
    this: AbortController,
    reason?: unknown,
  ) {
    abort.call(this, reason);
    if (this !== controller) abort.call(controller);
  });
  try {
    const request = fetchData(f.registry, controller.signal, f.fetcher);
    await expect(request).rejects.toMatchObject({ code: "cancelled" });
  } finally {
    cleanup.mockRestore();
  }
});

it("does not resolve auth for an already-cancelled catalog request", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  const request = fetchCodexModelCatalog(f.registry, controller.signal, f.fetcher);
  await expect(request).rejects.toMatchObject({ code: "cancelled" });
  expect(f.registry.getProviderAuth).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("ignores auth resolving after a catalog request is cancelled", async () => {
  const f = fixture();
  const auth = deferred<AuthResult>();
  f.registry.getProviderAuth.mockReturnValue(auth.promise);
  const controller = new AbortController();
  const request = fetchCodexModelCatalog(f.registry, controller.signal, f.fetcher);
  controller.abort();
  await expect(request).rejects.toMatchObject({ code: "cancelled" });
  auth.resolve(f.auth);
  await auth.promise;
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("bounds the catalog's wait for Pi auth by the ten-second deadline", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const auth = deferred<AuthResult>();
  f.registry.getProviderAuth.mockReturnValue(auth.promise);
  const request = fetchCodexModelCatalog(f.registry, undefined, f.fetcher);
  const failure = expect(request).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(10_000);
  await failure;
  auth.resolve(f.auth);
  await auth.promise;
  expect(f.fetcher).not.toHaveBeenCalled();
  const timerCount = vi.getTimerCount();
  expect(timerCount).toBe(0);
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

it.each([
  ["usage", fetchCodexUsage],
  ["catalog", fetchCodexModelCatalog],
] as const)(
  "keeps the deadline active while consuming the %s body",
  async (_resource, fetchData) => {
    vi.useFakeTimers();
    const f = fixture();
    const cancel = vi.fn();
    f.fetcher.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel })));
    const result = expect(fetchData(f.registry, undefined, f.fetcher)).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);
