import { rmSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  InMemoryModelsStore,
  type Api,
  type CredentialStore,
  type Model,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import codex from "./index.ts";

const directory = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "codex-fast-sdk-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});

const CATALOG_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.162.0";
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const SOCKET_URL = "wss://chatgpt.com/backend-api/codex/responses";
const FAST_ENTRY = "eleith-codex-fast";
type Transport = "sse" | "websocket";

beforeEach(blockUnexpectedNetwork);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it.each(["sse", "websocket"] as const)(
  "SDK fast on reaches the native Codex %s wire, independently of the observed tier",
  async (transport) => {
    const network = installResponseTransports(transport);
    const { runtime, model, accessToken, credentialWrites, resolveAuth, modelTurns } =
      await createOfflineModelRuntime(transport, network.fetch);
    const { session, manager, confirm, notify, errors, closeSession } =
      await openRealExtensionSession(runtime, model);
    try {
      const branch = structuredClone(manager.getBranch());
      resolveAuth.mockClear();
      let dashboard: string | undefined;
      for (const command of ["/eleith:codex", "/eleith:codex fast", "/eleith:codex context"]) {
        const notifications = notify.mock.calls.length;
        await session.prompt(command);
        expect(notify).toHaveBeenCalledTimes(notifications + 1);
        expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Context:"), "info");
        expect(notify).toHaveBeenLastCalledWith(
          expect.stringContaining("Fast: Provider default (no override)"),
          "info",
        );
        const message = notify.mock.calls.at(-1)![0] as string;
        if (dashboard === undefined) dashboard = message;
        else expect(message).toBe(dashboard);
        expect(network.fetch).not.toHaveBeenCalled();
        expect(resolveAuth).not.toHaveBeenCalled();
        expect(credentialWrites).not.toHaveBeenCalled();
        expect(manager.getBranch()).toEqual(branch);
        expect(modelTurns).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
      }

      await session.prompt("/eleith:codex fast on");
      expect(confirm).toHaveBeenCalledOnce();
      expect(network.catalog).toHaveBeenCalledOnce();
      expect(network.catalog.mock.calls[0][0]).toBe(CATALOG_URL);
      const headers = new Headers(network.catalog.mock.calls[0][1]?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
      expect(headers.get("chatgpt-account-id")).toBe("fast-sdk-account");
      expect(fastChoices(manager)).toEqual([
        { provider: "openai-codex", modelId: model.id, mode: "on" },
      ]);
      expect(modelTurns).not.toHaveBeenCalled();
      expect(notify).toHaveBeenLastCalledWith(
        expect.stringContaining("Fast: On (priority requested)\nNo response tier reported yet."),
        "info",
      );

      resolveAuth.mockClear();
      await session.prompt("Reply with ok.");
      // Ordinary input checks the cached catalog's auth scope through Pi resolution only.
      expect(resolveAuth).toHaveBeenCalledWith("openai-codex");
      expect(network.catalog).toHaveBeenCalledOnce();
      expect(modelTurns).toHaveBeenCalledOnce();
      expect(network.payloads).toEqual([
        expect.objectContaining({ model: model.id, service_tier: "priority" }),
      ]);
      expect(session.getLastAssistantText()).toBe("ok");
      expect(network.sse).toHaveBeenCalledTimes(transport === "sse" ? 1 : 0);
      expect(network.sockets).toHaveLength(transport === "websocket" ? 1 : 0);
      if (transport === "websocket") {
        expect(network.payloads[0]).toHaveProperty("type", "response.create");
        expect(network.sockets[0].readyState).toBe(3);
      }

      const requests = network.fetch.mock.calls.length;
      resolveAuth.mockClear();
      const afterTurn = structuredClone(manager.getBranch());
      dashboard = undefined;
      for (const command of ["/eleith:codex", "/eleith:codex fast", "/eleith:codex context"]) {
        const notifications = notify.mock.calls.length;
        await session.prompt(command);
        expect(notify).toHaveBeenCalledTimes(notifications + 1);
        expect(notify).toHaveBeenLastCalledWith(
          expect.stringContaining("Fast: On (priority requested)\nLast reported tier: Standard"),
          "info",
        );
        expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Context:"), "info");
        const message = notify.mock.calls.at(-1)![0] as string;
        if (dashboard === undefined) dashboard = message;
        else expect(message).toBe(dashboard);
        expect(network.fetch).toHaveBeenCalledTimes(requests);
        expect(resolveAuth).not.toHaveBeenCalled();
        expect(manager.getBranch()).toEqual(afterTurn);
        expect(modelTurns).toHaveBeenCalledOnce();
        expect(credentialWrites).not.toHaveBeenCalled();
        expect(confirm).toHaveBeenCalledOnce();
      }

      await session.prompt("/eleith:codex fast toggle");
      expect(notify).toHaveBeenLastCalledWith(
        expect.stringContaining("Fast: Off (standard requested)"),
        "info",
      );
      expect(fastChoices(manager)).toEqual([
        { provider: "openai-codex", modelId: model.id, mode: "on" },
        { provider: "openai-codex", modelId: model.id, mode: "off" },
      ]);
      expect(confirm).toHaveBeenCalledOnce();
      expect(network.fetch).toHaveBeenCalledTimes(requests);
      expect(resolveAuth).not.toHaveBeenCalled();
      expect(modelTurns).toHaveBeenCalledOnce();
      expect(credentialWrites).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    } finally {
      await closeSession();
    }
  },
);

it("SDK replays the active fast branch alongside context controls, explicit off and legacy inherit", async () => {
  const network = installResponseTransports("sse");
  const { runtime, model, credentialWrites, resolveAuth, modelTurns } =
    await createOfflineModelRuntime("sse", network.fetch);
  const manager = SessionManager.inMemory(directory);
  const saved = { provider: "openai-codex", modelId: model.id, mode: "on" };
  const onLeaf = manager.appendCustomEntry(FAST_ENTRY, saved);
  // Leave a conflicting choice on an inactive sibling: replay must use getBranch(), not all entries.
  manager.appendCustomEntry(FAST_ENTRY, { ...saved, mode: "off" });
  manager.branch(onLeaf);
  const { session, confirm, notify, errors, closeSession } = await openRealExtensionSession(
    runtime,
    model,
    manager,
  );
  let extendedWindow: number | undefined;
  const outputLimit = session.model?.maxTokens;
  const thinking = session.thinkingLevel;
  try {
    expect(network.fetch).not.toHaveBeenCalled();
    const branch = structuredClone(manager.getBranch());
    resolveAuth.mockClear();
    await session.prompt("/eleith:codex fast");
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Fast: Paused — model eligibility needs checking"),
      "info",
    );
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Context:"), "info");
    expect(network.fetch).not.toHaveBeenCalled();
    expect(resolveAuth).not.toHaveBeenCalled();
    expect(credentialWrites).not.toHaveBeenCalled();
    expect(manager.getBranch()).toEqual(branch);
    expect(modelTurns).not.toHaveBeenCalled();

    await session.prompt("/eleith:codex context on");
    extendedWindow = session.model?.contextWindow;
    expect(extendedWindow).toBeGreaterThanOrEqual(model.contextWindow);
    expect(session.model?.maxTokens).toBe(outputLimit);
    expect(session.thinkingLevel).toBe(thinking);
    expect(network.fetch).not.toHaveBeenCalled();

    // No explicit fast command fetched metadata in this resumed session.
    await session.prompt("Reply with ok on the resumed branch.");
    expect(network.catalog).toHaveBeenCalledOnce();
    expect(network.payloads[0]).toMatchObject({ model: model.id, service_tier: "priority" });
    expect(fastChoices(manager)).toEqual([saved]);
    expect(confirm).not.toHaveBeenCalled();

    await session.prompt("/eleith:codex fast off");
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Fast: Off (standard requested)"),
      "info",
    );
    expect(fastChoices(manager)).toEqual([saved, { ...saved, mode: "off" }]);
    await session.prompt("Reply with ok without priority.");
    expect(network.payloads[1]).toMatchObject({ model: model.id, service_tier: "default" });
    expect(session.model?.contextWindow).toBe(extendedWindow);
    expect(session.model?.maxTokens).toBe(outputLimit);
    expect(session.thinkingLevel).toBe(thinking);
    expect(credentialWrites).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  } finally {
    await closeSession();
  }

  // Old sessions may contain inherit entries. Restore that schema, not a reset command.
  const inheritLeaf = manager.appendCustomEntry(FAST_ENTRY, { ...saved, mode: "inherit" });
  manager.appendCustomEntry(FAST_ENTRY, saved);
  manager.branch(inheritLeaf);
  const legacy = await openRealExtensionSession(runtime, model, manager);
  try {
    const branch = structuredClone(manager.getBranch());
    const requests = network.fetch.mock.calls.length;
    resolveAuth.mockClear();
    await legacy.session.prompt("/eleith:codex fast");
    expect(legacy.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Fast: Provider default (no override)"),
      "info",
    );
    expect(fastChoices(manager)).toEqual([
      saved,
      { ...saved, mode: "off" },
      { ...saved, mode: "inherit" },
    ]);
    expect(manager.getBranch()).toEqual(branch);
    expect(network.fetch).toHaveBeenCalledTimes(requests);
    expect(resolveAuth).not.toHaveBeenCalled();
    await legacy.session.prompt("Reply with ok using the provider default.");
    expect(network.payloads[2]).toHaveProperty("model", model.id);
    expect(network.payloads[2]).not.toHaveProperty("service_tier");
    expect(network.payloads).toHaveLength(3);
    expect(legacy.session.getLastAssistantText()).toBe("ok");
    expect(modelTurns).toHaveBeenCalledTimes(3);
    expect(network.catalog).toHaveBeenCalledOnce();
    expect(legacy.session.model?.contextWindow).toBe(extendedWindow);
    expect(legacy.session.model?.maxTokens).toBe(outputLimit);
    expect(legacy.session.thinkingLevel).toBe(thinking);
    expect(legacy.confirm).not.toHaveBeenCalled();
    expect(credentialWrites).not.toHaveBeenCalled();
    expect(legacy.errors).toEqual([]);
  } finally {
    await legacy.closeSession();
  }
});

// Network policy: globals start closed; the supplied fetch accepts only these two fixed URLs.
function blockUnexpectedNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network request");
    }),
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor() {
        throw new Error("Unexpected WebSocket request");
      }
    },
  );
}

function installResponseTransports(transport: Transport) {
  const payloads: Record<string, unknown>[] = [];
  const http = createHttpResponses(transport, payloads);
  vi.stubGlobal("fetch", http.fetch);
  const sockets = transport === "websocket" ? installSocketResponses(payloads) : [];
  return { ...http, payloads, sockets };
}

function createHttpResponses(transport: Transport, payloads: Record<string, unknown>[]) {
  const catalog = vi.fn<typeof fetch>(async () =>
    // The client wraps this internally as { data, authScope }; the network JSON does not.
    Response.json({ models: [{ slug: "gpt-6-sol", service_tiers: [{ id: "priority" }] }] }),
  );
  const sse = vi.fn<typeof fetch>(async (_url, init) => {
    if (transport !== "sse") throw new Error("Unexpected SSE fallback");
    payloads.push(readHttpPayload(init));
    const body = responseProtocolData()
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === CATALOG_URL) return catalog(url, init);
    if (String(url) === RESPONSES_URL) return sse(url, init);
    throw new Error("Unexpected network URL");
  });
  return { fetch: fetcher, catalog, sse };
}

function installSocketResponses(payloads: Record<string, unknown>[]) {
  const sockets: FakeWebSocket[] = [];
  class FakeWebSocket extends EventTarget {
    readyState = 0;

    constructor(url: string | URL) {
      super();
      if (String(url) !== SOCKET_URL) throw new Error("Unexpected WebSocket URL");
      sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }

    send(data: string) {
      if (this.readyState !== 1) throw new Error("WebSocket is not open");
      payloads.push(JSON.parse(data));
      queueMicrotask(() => {
        for (const frame of responseProtocolData()) {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
        }
      });
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  return sockets;
}

// Offline ModelRuntime: real built-in provider and OAuth resolution, never persistence or refresh I/O.
async function createOfflineModelRuntime(transport: Transport, fetcher: typeof fetch) {
  const claim = { "https://api.openai.com/auth": { chatgpt_account_id: "fast-sdk-account" } };
  const accessToken = `e30.${Buffer.from(JSON.stringify(claim)).toString("base64url")}.fake-signature`;
  const { credentials, credentialWrites } = createReadOnlyCredentials(accessToken);
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const refresh = await runtime.refresh({ providers: ["openai-codex"], allowNetwork: false });
  expect(refresh.errors.size).toBe(0);
  expect(runtime.isUsingOAuth("openai-codex")).toBe(true);
  const model = runtime.getModel("openai-codex", "gpt-6-sol");
  if (!model) throw new Error("Built-in Codex model missing");
  const resolveAuth = vi.spyOn(runtime, "getAuth");
  const nativeStream = runtime.streamSimple.bind(runtime);
  // Only select the transport at this public seam; retain native serialization and extension hooks.
  const modelTurns = vi
    .spyOn(runtime, "streamSimple")
    .mockImplementation((selected, context, options) =>
      nativeStream(selected, context, {
        ...options,
        transport,
        cacheRetention: "none", // No socket cache or idle-expiry timer survives a turn.
        fetch: fetcher,
      }),
    );
  return { runtime, model, accessToken, credentialWrites, resolveAuth, modelTurns };
}

function createReadOnlyCredentials(accessToken: string) {
  const freshOAuth: OAuthCredential = {
    type: "oauth",
    access: accessToken,
    refresh: "must-not-refresh",
    expires: Date.now() + 3_600_000,
  };
  const credentialWrites = vi.fn<CredentialStore["modify"]>(async () => {
    throw new Error("Credential writes forbidden");
  });
  const credentials: CredentialStore = {
    read: async (id) => (id === "openai-codex" ? freshOAuth : undefined),
    list: async () => [{ providerId: "openai-codex", type: "oauth" }],
    modify: credentialWrites,
    delete: async () => {
      throw new Error("Credential deletion forbidden");
    },
  };
  return { credentials, credentialWrites };
}

// Real extension session: production commands, branch persistence, and the public agent bridge.
async function openRealExtensionSession(
  runtime: ModelRuntime,
  model: Model<Api>,
  manager = SessionManager.inMemory(directory),
) {
  const settingsManager = SettingsManager.inMemory({
    packages: [],
    enableInstallTelemetry: false,
    enableAnalytics: false,
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [codex],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader,
    settingsManager,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    sessionManager: manager,
    noTools: "all",
  });
  const confirm = vi.fn(async () => true);
  const notify = vi.fn();
  const errors: unknown[] = [];
  await session.bindExtensions({
    mode: "tui",
    uiContext: { notify, confirm } as unknown as ExtensionUIContext,
    onError: (error) => errors.push(error),
  });
  return {
    session,
    manager,
    confirm,
    notify,
    errors,
    async closeSession() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    },
  };
}

function fastChoices(manager: SessionManager) {
  return manager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === FAST_ENTRY ? [entry.data] : [],
    );
}

// Response protocol data: deliberately report default, not the requested priority.
function responseProtocolData() {
  const message = {
    type: "message",
    id: "answer",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  };
  return [
    { type: "response.created", response: { id: "response" } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: { id: "response", status: "completed", service_tier: "default", output: [message] },
    },
  ];
}

function readHttpPayload(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body === "string") return JSON.parse(init.body);
  if (
    init?.body instanceof Uint8Array &&
    new Headers(init.headers).get("content-encoding") === "zstd"
  ) {
    return JSON.parse(zstdDecompressSync(init.body).toString("utf8"));
  }
  throw new Error("Unexpected Codex request body");
}
