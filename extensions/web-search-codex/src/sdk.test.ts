import { rmSync } from "node:fs";
import { afterAll, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  InMemoryModelsStore,
  type Api,
  type FauxContentBlock,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import webSearchCodex from "./index.ts";

const directory = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "web-search-codex-sdk-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("loads into Pi, runs through the actual agent/tool pipeline, records usage, and permits renderer overrides", async () => {
  initTheme("dark", false);
  const runtime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw Error("No credential writes");
      },
      delete: async () => {
        throw Error("No credential deletes");
      },
    },
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  let nestedUsage = 0;
  const turns = vi.fn(
    (selected: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      void Promise.resolve()
        .then(async () => {
          const last = context.messages.at(-1);
          const nested = last?.role === "user" && last.content === "Pi docs";
          if (nested) {
            const payload = await options?.onPayload?.({}, selected);
            expect(payload).toMatchObject({
              tools: [{ type: "web_search" }],
              tool_choice: "required",
            });
            await options?.onProviderStreamEvent?.(
              { type: "response.web_search_call.completed" },
              selected,
            );
          }
          let content: FauxContentBlock;
          if (nested) {
            content = fauxText("Pi docs are at https://pi.dev/");
          } else if (last?.role === "toolResult") {
            content = fauxText("Search completed.");
          } else {
            content = fauxToolCall("web_search_codex", { query: "Pi docs" }, { id: "search-1" });
          }
          const message = fauxAssistantMessage([content], {
            stopReason: content.type === "toolCall" ? "toolUse" : "stop",
          });
          Object.assign(message, {
            provider: selected.provider,
            api: selected.api,
            model: selected.id,
          });
          if (nested) {
            nestedUsage = 17;
            message.usage = {
              input: 10,
              output: 7,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: nestedUsage,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            };
          }
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
          stream.end();
        })
        .catch((error) => {
          const message = fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: String(error),
          });
          stream.push({ type: "error", reason: "error", error: message });
          stream.end();
        });
      return stream;
    },
  );
  runtime.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    apiKey: "not-a-real-key",
    baseUrl: "https://never-connect.invalid",
    models: [
      {
        id: "fake",
        name: "Fake",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 10000,
      },
    ],
    streamSimple: turns,
  });
  const model = runtime.getModel("openai-codex", "fake");
  if (!model) throw Error("Missing fake model");
  let override = false;
  const customize = (pi: ExtensionAPI) =>
    pi.registerToolRenderer((name, next) =>
      name === "web_search_codex" && override
        ? {
            renderShell: "default",
            renderCall: () => new Text("custom search renderer", 0, 0),
            renderResult: () => new Text("custom search result", 0, 0),
          }
        : next(),
    );
  const settingsManager = SettingsManager.inMemory({
    packages: [],
    enableInstallTelemetry: false,
    enableAnalytics: false,
    cacheWarming: "off",
    retry: { enabled: false },
    compaction: { enabled: false },
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
    extensionFactories: [webSearchCodex, customize],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader: loader,
    settingsManager,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(directory),
  });
  try {
    await session.bindExtensions({ mode: "print" });
    expect(session.getActiveToolNames()).toContain("web_search_codex");
    await session.prompt("Search now");
    expect(turns).toHaveBeenCalledTimes(3);
    const result = session.messages.find((message) => message.role === "toolResult");
    expect(result).toMatchObject({
      toolName: "web_search_codex",
      isError: false,
      usage: { totalTokens: nestedUsage },
      details: { version: 1, status: "done", searched: true },
    });
    const original = session.getToolDefinition("web_search_codex");
    const resolve = () =>
      session.extensionRunner.resolveToolRenderers("web_search_codex", () => original);
    const framed = resolve();
    expect(framed?.renderShell).toBe("self");
    const row = new ToolExecutionComponent(
      "web_search_codex",
      "render-probe",
      {},
      {},
      framed,
      { requestRender() {} } as never,
      directory,
    );
    for (const width of [1, 5, 40, 80])
      for (const line of row.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    override = true;
    expect(resolve()?.renderShell).toBe("default");
    expect(session.getToolDefinition("web_search_codex")).toBe(original);
    expect(original?.execute).toBeDefined();
    await session.prompt("/eleith:web-search-codex off");
    expect(session.getActiveToolNames()).not.toContain("web_search_codex");
    await session.prompt("/eleith:web-search-codex on");
    expect(session.getActiveToolNames()).toContain("web_search_codex");
    expect(turns).toHaveBeenCalledTimes(3);
  } finally {
    session.dispose();
  }
});
