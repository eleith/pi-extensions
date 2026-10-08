import { rmSync } from "node:fs";
import { afterAll, expect, it, vi } from "vitest";
import { InMemoryModelsStore, type CredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
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

async function fixture(window = 272_000) {
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
    models: ["gpt-6-sol", "external"].map((id) => ({
      id,
      name: id,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: window,
      maxTokens: 128_000,
    })),
    streamSimple: stream,
  });
  const catalog = runtime.getModel("openai-codex", "gpt-6-sol");
  const external = runtime.getModel("openai-codex", "external");
  if (!catalog || !external) throw new Error("Fake model missing");
  const settingsManager = SettingsManager.inMemory({
    packages: [],
    enableInstallTelemetry: false,
    enableAnalytics: false,
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
    defaultThinkingLevel: "medium",
  });
  const modelSelect = vi.fn();
  let registry!: ExtensionContext["modelRegistry"];
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      contextWindow,
      (pi) => {
        pi.on("model_select", modelSelect);
        pi.on("session_start", (_event, ctx) => {
          registry = ctx.modelRegistry;
        });
      },
    ],
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
  const notify = vi.fn();
  await session.bindExtensions({
    mode: "tui",
    uiContext: { notify, confirm } as unknown as ExtensionUIContext,
    onError: (error) => errors.push(error),
  });
  return {
    session,
    runtime,
    manager,
    catalog,
    external,
    confirm,
    notify,
    modelSelect,
    get registry() {
      return registry;
    },
    preferences() {
      return manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "eleith-context")
        .map((entry) => (entry.type === "custom" ? entry.data : undefined));
    },
    async cleanup() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      expect(stream).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    },
  };
}

it.each([272_000, 300_000, 1_000_000])(
  "SDK catalog %s stays independent through extend, reload, and confirmed restore",
  async (window) => {
    const f = await fixture(window);
    const original = structuredClone(f.catalog);
    try {
      const leaf = f.manager.getLeafId();
      await f.session.prompt("/eleith:context extend");
      const extended = f.session.model!;
      expect(extended.contextWindow).toBe(Math.max(window, 922_000));
      if (window < 922_000) {
        expect(extended).not.toBe(f.catalog);
        expect(f.manager.getLeafId()).not.toBe(leaf);
        expect(f.manager.getBranch().some((entry) => entry.type === "model_change")).toBe(true);
      }
      expect(f.registry.find("openai-codex", "gpt-6-sol")).toEqual(original);
      expect(f.modelSelect).not.toHaveBeenCalled(); // actual same-ID suppression
      expect(f.session.thinkingLevel).toBe("high");
      await f.session.reload();
      expect(f.session.model?.contextWindow).toBe(Math.max(window, 922_000));
      expect(f.registry.find("openai-codex", "gpt-6-sol")?.contextWindow).toBe(window);
      await f.session.prompt("/eleith:context restore");
      expect(f.session.model?.contextWindow).toBe(window);
      expect(extended.contextWindow).toBe(Math.max(window, 922_000));
      expect(f.catalog).toEqual(original);
      expect(f.confirm).toHaveBeenCalledTimes(window < 922_000 ? 1 : 0);
      expect(f.session.thinkingLevel).toBe("high");
      expect(f.modelSelect).not.toHaveBeenCalled();
      expect(f.preferences()).toEqual([
        { provider: "openai-codex", modelId: "gpt-6-sol", extended: true },
        { provider: "openai-codex", modelId: "gpt-6-sol", extended: false },
      ]);
      if (window >= 922_000)
        expect(f.notify).toHaveBeenLastCalledWith(
          expect.stringContaining("no smaller default is known"),
          "info",
        );
    } finally {
      await f.cleanup();
    }
  },
);

it.each(["rename", "external"])(
  "SDK delayed auth with %s warns without repair, thinking rewrite, success records, or replay",
  async (event) => {
    const f = await fixture();
    const originalExternal = structuredClone(f.external);
    const originalCatalog = structuredClone(f.catalog);
    let resume!: () => void;
    let start!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const checkAuth = f.runtime.checkAuth.bind(f.runtime);
    const auth = vi
      .spyOn(f.runtime, "checkAuth")
      .mockImplementationOnce(async (provider, options) => {
        start();
        await paused;
        return checkAuth(provider, options);
      });
    const selection = vi.spyOn(f.session, "setModel");
    try {
      const request = f.session.prompt("/eleith:context extend");
      await started;
      const submitted = selection.mock.calls[0][0];
      const originalSubmitted = structuredClone(submitted);
      if (event === "rename") f.session.setSessionName("Renamed during authentication");
      else {
        await f.session.setModel(f.external);
        f.session.setThinkingLevel("high");
      }
      resume();
      await request;
      expect(f.session.model?.contextWindow).toBe(922_000);
      expect(f.session.model?.id).toBe("gpt-6-sol"); // older call can replace external intent
      expect(submitted).toEqual(originalSubmitted);
      expect(f.catalog).toEqual(originalCatalog);
      expect(f.external).toEqual(originalExternal);
      expect(f.preferences()).toEqual([]);
      expect(f.session.thinkingLevel).toBe("medium"); // no repair after disputed completion
      expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("uncertain"), "warning");
      expect(f.modelSelect).toHaveBeenCalledTimes(event === "external" ? 2 : 0);
      const thinking = f.session.thinkingLevel;
      const thinkingWrites = vi.spyOn(f.session, "setThinkingLevel");
      await f.session.extensionRunner.emitInput("not a provider turn", undefined, "interactive");
      expect(selection).toHaveBeenCalledTimes(event === "external" ? 2 : 1);
      expect(thinkingWrites).not.toHaveBeenCalled();
      expect(f.session.thinkingLevel).toBe(thinking);
      // Only an explicit context-changing command resumes work.
      await f.session.prompt("/eleith:context restore");
      expect(f.session.model?.contextWindow).toBe(272_000);
      expect(f.preferences()).toEqual([
        { provider: "openai-codex", modelId: "gpt-6-sol", extended: false },
      ]);
      thinkingWrites.mockRestore();
    } finally {
      resume();
      auth.mockRestore();
      selection.mockRestore();
      await f.cleanup();
    }
  },
);

it.each(["missing", "endpoint"])(
  "SDK refuses %s catalog baseline without selecting",
  async (reason) => {
    const f = await fixture();
    try {
      await f.session.prompt("/eleith:context extend");
      const lookup = vi
        .spyOn(f.registry, "find")
        .mockReturnValue(
          reason === "missing" ? undefined : { ...f.catalog, baseUrl: "https://different.invalid" },
        );
      const select = vi.spyOn(f.session, "setModel");
      await f.session.prompt("/eleith:context restore");
      expect(select).not.toHaveBeenCalled();
      expect(f.session.model?.contextWindow).toBe(922_000);
      expect(f.confirm).not.toHaveBeenCalled();
      expect(f.preferences()).toHaveLength(1);
      expect(f.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("baseline is unknown"),
        "warning",
      );
      lookup.mockRestore();
      select.mockRestore();
    } finally {
      await f.cleanup();
    }
  },
);
