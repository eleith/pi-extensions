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
} from "@earendil-works/pi-coding-agent";
import { matchesDirectCodexSelection } from "./request-scope.ts";

const directory = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "codex-request-scope-sdk-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});
beforeEach(blockUnexpectedNetwork);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("SDK direct-selection payload transforms reach the native Codex SSE request", async () => {
  const httpRequest = stubCodexResponse();
  const { runtime, model } = await createOfflineCodexRuntime(httpRequest);
  const { session, decisions, errors, closeSession } = await openProbeSession(runtime, model);
  try {
    await session.prompt("Reply with ok.");
    expect(decisions).toEqual([true]);
    expect(httpRequest).toHaveBeenCalledOnce();
    const [, init] = httpRequest.mock.calls[0];
    expect(readHttpPayload(init)).toMatchObject({ model: model.id, service_tier: "priority" });
    expect(session.getLastAssistantText()).toBe("ok");
    expect(errors).toEqual([]);
  } finally {
    await closeSession();
  }
});

it("SDK virtual selections remain outside scope even when their dispatch is native Codex", async () => {
  const httpRequest = stubCodexResponse();
  const { runtime, model } = await createOfflineCodexRuntime(httpRequest);
  runtime.registerVirtualModel({
    provider: "openai-codex",
    id: "auto",
    name: "Test route",
    route: () => ({ model, thinkingLevel: "off" }),
  });
  const selected = runtime.getModel("openai-codex", "auto");
  if (!selected) throw new Error("Virtual test model missing");
  const { session, decisions, errors, closeSession } = await openProbeSession(runtime, selected);
  try {
    await session.prompt("Reply with ok.");
    expect(decisions).toEqual([false]);
    expect(session.model?.api).toBe("pi-virtual");
    const [, init] = httpRequest.mock.calls[0];
    const payload = readHttpPayload(init);
    expect(payload.model).toBe(model.id);
    expect(payload).not.toHaveProperty("service_tier");
    expect(session.getLastAssistantText()).toBe("ok");
    expect(errors).toEqual([]);
  } finally {
    await closeSession();
  }
});

async function createOfflineCodexRuntime(httpRequest: typeof fetch) {
  const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "scope-test-account" } };
  const access = `e30.${Buffer.from(JSON.stringify(payload)).toString("base64")}.fake-signature`;
  const credential: OAuthCredential = {
    type: "oauth",
    access,
    refresh: "must-not-refresh",
    expires: Date.now() + 3_600_000,
  };
  const credentials: CredentialStore = {
    read: async (id) => {
      if (id !== "openai-codex") return undefined;
      return credential;
    },
    list: async () => [{ providerId: "openai-codex", type: "oauth" }],
    modify: async () => {
      throw new Error("Credential writes forbidden");
    },
    delete: async () => {
      throw new Error("Credential deletion forbidden");
    },
  };
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const refresh = await runtime.refresh({ providers: ["openai-codex"], allowNetwork: false });
  expect(refresh.errors.size).toBe(0);
  const model = runtime.getModel("openai-codex", "gpt-6-sol");
  if (!model) throw new Error("Built-in test model missing");

  const nativeStream = runtime.streamSimple.bind(runtime);
  // Force this transport through a public test seam; keep the real provider and extension bridge.
  vi.spyOn(runtime, "streamSimple").mockImplementation((selected, context, options) =>
    nativeStream(selected, context, {
      ...options,
      transport: "sse",
      cacheRetention: "none",
      fetch: httpRequest,
    }),
  );
  return { runtime, model };
}

async function openProbeSession(runtime: ModelRuntime, model: Model<Api>) {
  const decisions: boolean[] = [];
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
    extensionFactories: [
      (pi) => {
        pi.on("before_provider_request", (event, ctx) => {
          const payload = event.payload;
          const matches = matchesDirectCodexSelection(payload, ctx);
          decisions.push(matches);
          // Test-only transform; production registration belongs to the fast-command changeset.
          if (matches) return { ...payload, service_tier: "priority" };
        });
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader,
    settingsManager,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(directory),
    noTools: "all",
  });
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  return {
    session,
    decisions,
    errors,
    async closeSession() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    },
  };
}

function stubCodexResponse() {
  const message = {
    type: "message",
    id: "answer",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  };
  const events = [
    { type: "response.created", response: { id: "response" } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: { id: "response", status: "completed", output: [message] },
    },
  ];
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return vi.fn<typeof fetch>(async (url) => {
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  });
}

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
