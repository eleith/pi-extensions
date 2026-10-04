import { rmSync } from "node:fs";
import { afterAll, expect, it, vi } from "vitest";
import { InMemoryModelsStore, type CredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import contextWindow from "./index.ts";

const directory = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "context-sdk-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("preserves real SDK model identity, thinking, and branch preferences across metadata-only switches", async () => {
  const credentials: CredentialStore = {
    read: async () => undefined,
    list: async () => [],
    modify: async () => {
      throw new Error("Credential persistence forbidden");
    },
    delete: async () => {
      throw new Error("Credential persistence forbidden");
    },
  };
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const stream = vi.fn(() => {
    throw new Error("Provider turns forbidden");
  });
  runtime.registerProvider("openai-codex", {
    api: "context-sdk-test",
    baseUrl: "https://must-not-connect.invalid",
    apiKey: "disposable-not-a-real-key",
    models: [
      {
        id: "gpt-6-sol",
        name: "Fake Sol",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272_000,
        maxTokens: 128_000,
      },
    ],
    streamSimple: stream,
  });
  const catalog = runtime.getModel("openai-codex", "gpt-6-sol");
  if (!catalog) throw new Error("Fake model missing");
  const settingsManager = SettingsManager.inMemory({
    packages: [],
    enableInstallTelemetry: false,
    enableAnalytics: false,
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [contextWindow],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const manager = SessionManager.inMemory(directory);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader: loader,
    settingsManager,
    modelRuntime: runtime,
    model: catalog,
    thinkingLevel: "high",
    sessionManager: manager,
    noTools: "all",
  });
  const errors: unknown[] = [];
  const confirm = vi.fn(async () => true);
  try {
    await session.bindExtensions({
      mode: "tui",
      uiContext: { notify: vi.fn(), confirm } as unknown as ExtensionUIContext,
      onError: (error) => errors.push(error),
    });
    await session.prompt("/eleith:context extend");
    expect(session.model).not.toBe(catalog);
    expect(session.model?.contextWindow).toBe(922_000);
    expect(catalog.contextWindow).toBe(272_000);
    expect(session.thinkingLevel).toBe("high");
    await session.prompt("/eleith:context restore");
    expect(session.model?.contextWindow).toBe(272_000);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(session.thinkingLevel).toBe("high");
    expect(
      manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "eleith-context")
        .map((entry) => (entry.type === "custom" ? entry.data : undefined)),
    ).toEqual([
      { provider: "openai-codex", modelId: "gpt-6-sol", extended: true },
      { provider: "openai-codex", modelId: "gpt-6-sol", extended: false },
    ]);
    // A rename during authentication is a real branch addition, unlike setModel's own metadata.
    let resumeAuthentication!: () => void;
    let authenticationStarted!: () => void;
    const paused = new Promise<void>((resolve) => {
      resumeAuthentication = resolve;
    });
    const started = new Promise<void>((resolve) => {
      authenticationStarted = resolve;
    });
    const checkAuth = runtime.checkAuth.bind(runtime);
    const auth = vi
      .spyOn(runtime, "checkAuth")
      .mockImplementationOnce(async (provider, options) => {
        authenticationStarted();
        await paused;
        return checkAuth(provider, options);
      });
    try {
      const request = session.prompt("/eleith:context extend");
      await started;
      session.setSessionName("Renamed during authentication");
      resumeAuthentication();
      await request;
      expect(session.model?.contextWindow).toBe(272_000);
      expect(session.thinkingLevel).toBe("high");
      expect(
        manager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "eleith-context"),
      ).toHaveLength(2);
    } finally {
      resumeAuthentication();
      auth.mockRestore();
    }
    expect(stream).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});
