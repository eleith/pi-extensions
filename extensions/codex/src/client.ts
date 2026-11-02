import { createHash } from "node:crypto";
import type { AuthResult, Provider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const BASE_URL = "https://chatgpt.com/backend-api";
const ACCOUNT_URLS = {
  usage: `${BASE_URL}/wham/usage`,
  catalog: `${BASE_URL}/codex/models?client_version=0.162.0`,
} as const;
type NetworkResource = keyof typeof ACCOUNT_URLS;
type AccountResource = NetworkResource | "auth";
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type CodexAccountRegistry = Pick<
  ExtensionContext["modelRegistry"],
  "getProviderAuth" | "isUsingOAuth"
> & {
  getProvider(id: string): Pick<Provider, "baseUrl" | "getModels"> | undefined;
};

interface AccountData {
  data: unknown;
  authScope: string;
}

export type CodexModelCatalog = AccountData;

type Failure = "auth" | "unsupported" | "cancelled" | "timeout" | "network" | "response" | "http";

export class CodexAccountError extends Error {
  constructor(
    readonly code: Failure,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "CodexAccountError";
  }
}

/** Read account data with Pi's existing login. Pi owns credential refresh and persistence. */
export async function fetchCodexUsage(
  registry: CodexAccountRegistry,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const result = await readAccountData("usage", registry, signal, fetcher);
  if (signal?.aborted) throw new CodexAccountError("cancelled", "Codex account request cancelled.");
  return result.data;
}

export async function fetchCodexModelCatalog(
  registry: CodexAccountRegistry,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<CodexModelCatalog> {
  const result = await readAccountData("catalog", registry, signal, fetcher);
  if (signal?.aborted) throw new CodexAccountError("cancelled", "Codex account request cancelled.");
  return result;
}

export async function readCodexAuthScope(
  registry: CodexAccountRegistry,
  signal?: AbortSignal,
): Promise<string> {
  const result = await readAccountData("auth", registry, signal);
  if (signal?.aborted) throw new CodexAccountError("cancelled", "Codex account request cancelled.");
  return result.authScope;
}

async function readAccountData(
  resource: AccountResource,
  registry: CodexAccountRegistry,
  signal: AbortSignal | undefined,
  fetcher: typeof fetch = fetch,
): Promise<AccountData> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    requestSignal.throwIfAborted();
    const headers = await resolveAccountHeaders(registry, requestSignal);
    requestSignal.throwIfAborted();
    // Hash only the normalized credentials we actually send, never persist raw headers.
    const authScope = createHash("sha256")
      .update(JSON.stringify([headers.get("authorization"), headers.get("chatgpt-account-id")]))
      .digest("hex");
    if (resource === "auth") return { data: undefined, authScope };
    const data = await requestAccountJson(resource, headers, requestSignal, fetcher);
    requestSignal.throwIfAborted();
    return { data, authScope };
  } catch (error) {
    if (signal?.aborted)
      throw new CodexAccountError("cancelled", "Codex account request cancelled.");
    if (deadline.signal.aborted)
      throw new CodexAccountError("timeout", "Codex account request timed out.");
    if (error instanceof CodexAccountError) throw error;
    // Neither auth errors nor fetch errors are safe to display verbatim.
    throw new CodexAccountError("network", "Could not reach the Codex account service.");
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}

async function resolveAccountHeaders(
  registry: CodexAccountRegistry,
  signal: AbortSignal,
): Promise<Headers> {
  const provider = registry.getProvider(PROVIDER);
  const model = provider
    ?.getModels()
    .find(
      (candidate) =>
        candidate.provider === PROVIDER &&
        candidate.api === "openai-codex-responses" &&
        officialBase(candidate.baseUrl),
    );
  if (!officialBase(provider?.baseUrl) || !model) {
    throw new CodexAccountError(
      "unsupported",
      "Account requests require the official Codex provider.",
    );
  }
  if (!registry.isUsingOAuth(model)) throw authError();

  let resolvedAuth: AuthResult | undefined;
  try {
    // Pi owns token refresh; aborting here only stops our wait for its result.
    resolvedAuth = await waitWithAbort(registry.getProviderAuth(PROVIDER), signal);
  } catch {
    throw authError();
  }
  signal.throwIfAborted();
  // Pi's resolved source describes these credentials, unlike its availability snapshot.
  if (!resolvedAuth || resolvedAuth.source !== "OAuth") throw authError();
  if (
    !officialBase(registry.getProvider(PROVIDER)?.baseUrl) ||
    (resolvedAuth.auth.baseUrl !== undefined && !officialBase(resolvedAuth.auth.baseUrl))
  ) {
    throw new CodexAccountError(
      "unsupported",
      "Account requests do not support endpoint overrides.",
    );
  }
  const accessToken = resolvedAuth.auth.apiKey;
  if (!accessToken) throw authError();
  // Match Pi's legacy transport: token routing overrides configured account headers.
  const accountId = tokenAccountId(accessToken);
  if (!accountId) throw authError();
  try {
    // Forward only the two credentials needed by this fixed endpoint, never
    // arbitrary provider headers or provider-scoped environment values.
    return new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
    });
  } catch {
    throw authError();
  }
}

function officialBase(url: string | undefined): boolean {
  return url?.replace(/\/+$/, "") === BASE_URL;
}

function tokenAccountId(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    // Routing metadata only, not signature verification. Legacy Pi Codex auth
    // returns the access token without the account header its transport derives.
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || !("https://api.openai.com/auth" in payload))
      return undefined;
    const claim = payload["https://api.openai.com/auth"];
    if (!claim || typeof claim !== "object" || !("chatgpt_account_id" in claim)) return undefined;
    const accountId = claim.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId.trim()) return undefined;
    return accountId;
  } catch {
    return undefined;
  }
}

function authError(): CodexAccountError {
  return new CodexAccountError(
    "auth",
    "Codex account access is unavailable. Check your Pi Codex login.",
  );
}

async function requestAccountJson(
  resource: NetworkResource,
  headers: Headers,
  requestSignal: AbortSignal,
  fetcher: typeof fetch,
): Promise<unknown> {
  let receivedResponse: Response | undefined;
  try {
    const request = fetcher(ACCOUNT_URLS[resource], {
      method: "GET",
      headers,
      redirect: "error",
      signal: requestSignal,
    }).then((response) => {
      receivedResponse = response;
      // Fetch adapters can ignore abort and deliver a response after we stopped waiting.
      if (requestSignal.aborted) {
        discardBody(response);
        requestSignal.throwIfAborted();
      }
      return response;
    });
    const response = await waitWithAbort(request, requestSignal);
    if (!response.ok) throw responseError(response);
    return await readJson(response, requestSignal);
  } finally {
    if (receivedResponse && !receivedResponse.bodyUsed) discardBody(receivedResponse);
  }
}

function responseError(response: Response): CodexAccountError {
  if (response.status === 401 || response.status === 403) return authError();
  if (response.status === 429) {
    return new CodexAccountError(
      "http",
      "Codex account service is rate limited.",
      parseRetryAfterMs(response.headers.get("retry-after")),
    );
  }
  return new CodexAccountError("http", `Codex account request failed (HTTP ${response.status}).`);
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  let delayMs: number;
  if (Number.isFinite(seconds)) delayMs = seconds * 1000;
  else delayMs = Date.parse(header) - Date.now();
  if (!Number.isFinite(delayMs) || delayMs < 0) return undefined;
  return delayMs;
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const bytes = await readResponseBytes(response, signal);
  signal.throwIfAborted();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw new CodexAccountError("response", "Codex account service returned invalid JSON.");
  }
}

async function readResponseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new CodexAccountError("response", "Codex account response was empty.");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let bytesRead = 0;
  let fullyRead = false;
  try {
    for (;;) {
      const { value, done } = await waitWithAbort(reader.read(), signal);
      if (done) {
        fullyRead = true;
        return bytes.subarray(0, bytesRead);
      }
      if (value.byteLength > bytes.byteLength - bytesRead) {
        throw new CodexAccountError("response", "Codex account response was too large.");
      }
      bytes.set(value, bytesRead);
      bytesRead += value.byteLength;
    }
  } finally {
    if (!fullyRead) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The operation has already started; observe a late rejection without accepting its result.
    void promise.catch(() => {});
    signal.throwIfAborted();
  }
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const value = await Promise.race([promise, cancelled]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
