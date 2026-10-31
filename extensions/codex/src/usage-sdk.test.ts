import { rmSync } from "node:fs";
import { afterAll, expect, it, vi } from "vitest";
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
  const directory = mkdtempSync(join(tmpdir(), "codex-usage-sdk-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("SDK usage reuses Pi's OAuth without a model turn or credential write", async () => {
  const usageResponse = {
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 25,
        limit_window_seconds: 18_000,
        reset_after_seconds: 1800,
      },
    },
  };
  const accountRequest = vi.fn<typeof fetch>(async (url) => {
    if (url !== "https://chatgpt.com/backend-api/wham/usage") {
      throw new Error("Unexpected network request");
    }
    return new Response(JSON.stringify(usageResponse));
  });
  vi.stubGlobal("fetch", accountRequest);
  const { runtime, model, accessToken, credentialWrites, modelTurns } =
    await createOfflineCodexRuntime();
  const { session, sessionManager, notify, extensionErrors, closeSession } =
    await openCodexExtensionSession(runtime, model);
  try {
    const branch = structuredClone(sessionManager.getBranch());
    await session.prompt("/eleith:codex");
    expect(accountRequest).not.toHaveBeenCalled();

    await session.prompt("/eleith:codex usage");
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Primary (5h): 25% used"),
      "info",
    );
    expect(accountRequest).toHaveBeenCalledOnce();
    const headers = new Headers(accountRequest.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(headers.get("chatgpt-account-id")).toBe("sdk-test-account");
    expect(sessionManager.getBranch()).toEqual(branch);
    expect(session.model).toEqual(model);
    expect(credentialWrites).not.toHaveBeenCalled();
    expect(modelTurns).not.toHaveBeenCalled();
    expect(extensionErrors).toEqual([]);
  } finally {
    await closeSession();
  }
});

async function createOfflineCodexRuntime() {
  const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "sdk-test-account" } };
  const accessToken = `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fake-signature`;
  const credential: OAuthCredential = {
    type: "oauth",
    access: accessToken,
    refresh: "must-not-refresh",
    expires: Date.now() + 3_600_000,
  };
  const credentialWrites = vi.fn<CredentialStore["modify"]>(async () => {
    throw new Error("Credential writes forbidden");
  });
  const credentials: CredentialStore = {
    read: async (id) => (id === "openai-codex" ? credential : undefined),
    list: async () => [{ providerId: "openai-codex", type: "oauth" }],
    modify: credentialWrites,
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
  // Populate Pi's auth-availability snapshot without probing other providers or the network.
  const refresh = await runtime.refresh({ providers: ["openai-codex"], allowNetwork: false });
  expect(refresh.errors.size).toBe(0);
  expect(runtime.isUsingOAuth("openai-codex")).toBe(true);
  const modelTurns = vi.spyOn(runtime, "streamSimple").mockImplementation(() => {
    throw new Error("Model turns forbidden");
  });
  const model = runtime.getModel("openai-codex", "gpt-6-sol");
  if (!model) throw new Error("Built-in Codex model missing");
  return { runtime, model, accessToken, credentialWrites, modelTurns };
}

async function openCodexExtensionSession(runtime: ModelRuntime, model: Model<Api>) {
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
  const sessionManager = SessionManager.inMemory(directory);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader,
    settingsManager,
    modelRuntime: runtime,
    model,
    sessionManager,
    noTools: "all",
  });
  const notify = vi.fn();
  const extensionErrors: unknown[] = [];
  await session.bindExtensions({
    mode: "tui",
    uiContext: { notify } as unknown as ExtensionUIContext,
    onError: (error) => extensionErrors.push(error),
  });
  return {
    session,
    sessionManager,
    notify,
    extensionErrors,
    async closeSession() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    },
  };
}
