import { rmSync } from "node:fs";
import { afterAll, expect, it, vi } from "vitest";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
  initTheme,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import toolRendering from "./index.ts";

const directory = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "tool-rendering-sdk-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("handles real SDK streamed rows and cleans up hidden native bash timers without a final draw", async () => {
  initTheme("dark", false);
  const credentials = {
    read: async () => undefined,
    list: async () => [],
    modify: async () => {
      throw Error("Credential writes forbidden");
    },
    delete: async () => {
      throw Error("Credential deletes forbidden");
    },
  };
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const turns = vi.fn(() => {
    throw Error("Provider turns forbidden");
  });
  runtime.registerProvider("tool-rendering-sdk", {
    api: "tool-rendering-sdk",
    baseUrl: "https://never-connect.invalid",
    apiKey: "disposable-not-real",
    models: [
      {
        id: "fake",
        name: "Fake",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1000,
      },
    ],
    streamSimple: turns,
  });
  const model = runtime.getModel("tool-rendering-sdk", "fake");
  if (!model) throw Error("Fake model missing");
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
    extensionFactories: [toolRendering],
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
  const errors: unknown[] = [];
  const requestRender = vi.fn();
  try {
    await session.bindExtensions({
      mode: "tui",
      uiContext: { notify: vi.fn(), setWorkingMessage: vi.fn() } as unknown as ExtensionUIContext,
      onError: (error) => errors.push(error),
    });
    // ToolExecutionComponent receives incomplete argument objects before execution/validation.
    for (const name of ["bash", "read", "grep", "ls", "find", "write", "edit"]) {
      const definition = session.extensionRunner.getToolDefinition(name);
      expect(definition).toBeDefined();
      const row = new ToolExecutionComponent(
        name,
        `partial-${name}`,
        {},
        {},
        definition,
        { requestRender } as never,
        directory,
      );
      for (const width of [1, 5, 20, 80, 120])
        for (const line of row.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    const malformedBash = new ToolExecutionComponent(
      "bash",
      "malformed-command",
      { command: 123 },
      {},
      session.extensionRunner.getToolDefinition("bash"),
      { requestRender } as never,
      directory,
    );
    expect(() => malformedBash.render(80)).not.toThrow();
    const readRow = new ToolExecutionComponent(
      "read",
      "cached-read",
      { path: "before.txt" },
      {},
      session.extensionRunner.getToolDefinition("read"),
      { requestRender } as never,
      directory,
    );
    const readResult = {
      content: [
        {
          type: "text" as const,
          text: Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n"),
        },
      ],
      details: undefined,
      isError: false,
    };
    readRow.updateResult(readResult);
    const collapsed = readRow.render(80).join("\n");
    expect(collapsed).toContain("before.txt");
    expect(collapsed).not.toContain("line-11");
    expect(readRow.render(80).join("\n")).toBe(collapsed);
    readRow.setExpanded(true);
    expect(readRow.render(80).join("\n")).toContain("line-11");
    readRow.updateArgs({ path: "after.txt" });
    expect(readRow.render(80).join("\n")).toContain("after.txt");
    readRow.updateResult({ ...readResult, isError: true });
    expect(readRow.render(80).join("\n")).toContain("✗ error");
    const dark = readRow.render(80).join("\n");
    initTheme("light", false);
    readRow.invalidate();
    expect(readRow.render(80).join("\n")).not.toBe(dark);
    initTheme("dark", false);

    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const definition = session.extensionRunner.getToolDefinition("bash");
    if (!definition) throw Error("Bash definition missing");
    const row = new ToolExecutionComponent(
      "bash",
      "running-bash",
      { command: "printf example" },
      {},
      definition,
      { requestRender } as never,
      directory,
    );
    row.setArgsComplete();
    row.markExecutionStarted();
    row.updateResult(
      { content: [{ type: "text", text: "partial output" }], details: undefined, isError: false },
      true,
    );
    expect(vi.getTimerCount()).toBe(1);
    expect(row.render(80).join("\n")).toContain("0.0s");
    vi.advanceTimersByTime(1000);
    expect(row.render(80).join("\n")).toContain("1.0s");
    expect(row.render(80).join("\n")).toContain("1.0s");
    await session.prompt("/eleith:tool-rendering hide");
    expect(vi.getTimerCount()).toBe(0);
    row.invalidate();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    await session.extensionRunner.emit({
      type: "tool_execution_end",
      toolCallId: "running-bash",
      toolName: "bash",
      result: { content: [], details: undefined },
      isError: false,
    });
    expect(vi.getTimerCount()).toBe(0);
    // No final updateResult: the host can settle or reload before that row is drawn again.
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    expect(vi.getTimerCount()).toBe(0);
    expect(() => row.invalidate()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).toEqual([]);
    expect(turns).not.toHaveBeenCalled();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    session.dispose();
  }
});
