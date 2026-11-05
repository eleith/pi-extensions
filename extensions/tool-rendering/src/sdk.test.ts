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
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
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

it("uses the resolver chain and keeps streamed rows stable across toggles", async () => {
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
  const resolve = (name: string) =>
    session.extensionRunner.resolveToolRenderers(name, () => session.getToolDefinition(name));
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
      const definition = resolve(name);
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
      resolve("bash"),
      { requestRender } as never,
      directory,
    );
    expect(() => malformedBash.render(80)).not.toThrow();
    const readRow = new ToolExecutionComponent(
      "read",
      "cached-read",
      { path: "before.txt" },
      {},
      resolve("read"),
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

    checkOutputPadding(resolve, requestRender);

    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const definition = resolve("bash");
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
    expect(vi.getTimerCount()).toBe(1);
    expect(resolve("bash")).toBe(session.getToolDefinition("bash"));
    const nativeRow = new ToolExecutionComponent(
      "bash",
      "future-native",
      { command: "printf native" },
      {},
      resolve("bash"),
      { requestRender } as never,
      directory,
    );
    expect(nativeRow.render(80).join("\n")).not.toContain("collapsed");
    row.invalidate();
    expect(row.render(80).join("\n")).toContain("collapsed");
    expect(vi.getTimerCount()).toBe(1);
    await session.prompt("/eleith:tool-rendering show");
    expect(resolve("bash")?.renderShell).toBe("self");
    nativeRow.invalidate();
    expect(nativeRow.render(80).join("\n")).not.toContain("collapsed");
    vi.advanceTimersByTime(1000);
    await session.extensionRunner.emit({
      type: "tool_execution_end",
      toolCallId: "running-bash",
      toolName: "bash",
      result: { content: [], details: undefined },
      isError: false,
    });
    expect(vi.getTimerCount()).toBe(0);
    const completedResult = {
      content: [{ type: "text" as const, text: "completed output" }],
      details: undefined,
      isError: false,
      durationMs: 4200,
    };
    row.updateResult(completedResult);
    const completedLines = row.render(80);
    const completedText = completedLines.join("\n");
    expect(completedText).toContain("4.2s");
    expect(completedText).not.toContain("2.0s");

    // Restored rows receive recorded duration without markExecutionStarted().
    const restoredDefinition = resolve("bash");
    const restored = new ToolExecutionComponent(
      "bash",
      "restored-bash",
      { command: "printf restored" },
      {},
      restoredDefinition,
      { requestRender } as never,
      directory,
    );
    restored.setArgsComplete();
    restored.updateResult(completedResult);
    restored.setExpanded(true);
    restored.invalidate();
    const restoredLines = restored.render(80);
    const restoredText = restoredLines.join("\n");
    expect(restoredText).toContain("4.2s");
    expect(restoredText).toContain("expanded");
    const timerCount = vi.getTimerCount();
    expect(timerCount).toBe(0);

    // Shutdown also stops an abandoned framed row without fabricating a final result.
    const abandoned = new ToolExecutionComponent(
      "bash",
      "abandoned",
      { command: "printf pending" },
      {},
      resolve("bash"),
      { requestRender } as never,
      directory,
    );
    abandoned.setArgsComplete();
    abandoned.markExecutionStarted();
    abandoned.updateResult({ content: [], details: undefined, isError: false }, true);
    expect(vi.getTimerCount()).toBe(1);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    expect(vi.getTimerCount()).toBe(0);
    expect(() => row.invalidate()).not.toThrow();
    expect(() => abandoned.invalidate()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).toEqual([]);
    expect(turns).not.toHaveBeenCalled();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    session.dispose();
  }
});

function checkOutputPadding(
  resolve: (name: string) => ToolRenderers | undefined,
  requestRender: () => void,
): void {
  const paddingCases = [
    { name: "bash", args: { command: "printf '界🙂A'" } },
    { name: "read", args: { path: "padding.txt" } },
    { name: "grep", args: { pattern: "padding" } },
    { name: "ls", args: {} },
    { name: "find", args: { pattern: "*" } },
    { name: "write", args: { path: "padding.txt", content: "padding-body" } },
    { name: "edit", args: { path: "padding.txt", edits: [{ oldText: "old", newText: "new" }] } },
  ];
  const paddingResult = {
    content: [{ type: "text" as const, text: "padding-body" }],
    details: undefined,
    isError: false,
  };
  for (const { name, args } of paddingCases) {
    const definition = resolve(name);
    const paddedRow = new ToolExecutionComponent(
      name,
      `padding-${name}`,
      args,
      {},
      definition,
      { requestRender } as never,
      directory,
    );
    paddedRow.updateResult(paddingResult);
    paddedRow.setExpanded(true);
    const initial = paddedRow.render(80);
    const initialHeader = stripTerminalSequences(initial[1]);
    expect(initialHeader, name).toMatch(/^ ─/);
    for (const outputPad of [1, 0, 1]) {
      paddedRow.setOutputPad(outputPad);
      const rendered = paddedRow.render(80);
      const plain = rendered.map((line) => stripTerminalSequences(line));
      const expectedPrefix = " ".repeat(outputPad) + "─";
      const headerPrefix = plain[1].slice(0, outputPad + 1);
      const footerPrefix = plain.at(-1)!.slice(0, outputPad + 1);
      expect(headerPrefix, name).toBe(expectedPrefix);
      expect(footerPrefix, name).toBe(expectedPrefix);
      const body = plain.find((line) => line.includes("padding-body"));
      expect(body, name).toBeDefined();
      if (outputPad) {
        for (const line of plain) {
          if (!line.trim()) continue;
          const left = line[0];
          const right = line.at(-1);
          expect(left, name).toBe(" ");
          expect(right, name).toBe(" ");
        }
      }
      for (const width of [1, 2, 3, 5, 80, 250]) {
        const resized = paddedRow.render(width);
        for (const line of resized) {
          const columns = visibleWidth(line);
          expect(columns, name).toBeLessThanOrEqual(width);
        }
      }
    }
    const failed = { ...paddingResult, isError: true };
    paddedRow.updateResult(failed);
    const errorLines = paddedRow.render(80);
    const lastErrorLine = errorLines.at(-1)!;
    const errorFooter = stripTerminalSequences(lastErrorLine);
    expect(errorFooter, name).toMatch(/^ ─/);
    expect(errorFooter, name).toContain("✗");
  }
}
