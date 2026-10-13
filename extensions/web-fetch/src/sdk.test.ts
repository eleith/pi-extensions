import { rmSync } from "node:fs";
import { afterAll, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  InMemoryModelsStore,
  type Api,
  type JsonObject,
  type Model,
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
import { Text, TuiMainScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import type { FetchHooks, FetchInput, FetchResult } from "./core/types.ts";
import webFetch from "./index.ts";

const fixture = await vi.hoisted(async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = join(process.cwd(), ".cache");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "web-fetch-sdk-"));
  mkdirSync(join(directory, "extensions"));
  writeFileSync(
    join(directory, "extensions", "eleith.json"),
    JSON.stringify({ commandPrefix: "personal" }),
  );
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return { directory, single: vi.fn(), batch: vi.fn() };
});
vi.mock("./core/fetch.ts", () => ({ executeFetch: fixture.single }));
vi.mock("./core/batch.ts", () => ({ executeBatch: fixture.batch }));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(fixture.directory, { recursive: true, force: true });
});
function outcome(url: string): FetchResult {
  if (url.endsWith("/failure")) return { kind: "error", code: "timeout", message: "deadline", url };
  return {
    kind: "content",
    url,
    finalUrl: `${url}/final`,
    statusCode: 200,
    contentType: "text/html",
    title: "Offline article",
    author: "Fixture author",
    published: "2026-01-01",
    site: "Fixture",
    language: "en",
    wordCount: 5,
    content: "Fetched article preview\nsecond preview line\nexpanded final line",
    truncated: false,
    warnings: [],
  };
}

it("loads exactly two tools into real Pi print pipeline, persists structured/errors and overrides renderers without replacing execution", async () => {
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
  let selectedCall: { name: string; args: JsonObject } = {
    name: "web_fetch",
    args: { url: "https://offline.test/article" },
  };
  const turns = vi.fn((selected: Model<Api>, context: TranscriptContext) => {
    const stream = createAssistantMessageEventStream();
    const last = context.messages.at(-1);
    const content =
      last?.role === "toolResult"
        ? fauxText("Fixture done.")
        : fauxToolCall(selectedCall.name, selectedCall.args, {
            id: `fixture-${context.messages.length}`,
          });
    const message = fauxAssistantMessage([content], {
      stopReason: content.type === "toolCall" ? "toolUse" : "stop",
    });
    Object.assign(message, { provider: selected.provider, api: selected.api, model: selected.id });
    stream.push({ type: "start", partial: message });
    stream.push({
      type: "done",
      reason: content.type === "toolCall" ? "toolUse" : "stop",
      message,
    });
    stream.end();
    return stream;
  });
  runtime.registerProvider("fetch-fixture", {
    api: "openai-completions",
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
  const model = runtime.getModel("fetch-fixture", "fake");
  if (!model) throw Error("Missing fake model");
  let override = false;
  const nextCalls = vi.fn();
  const customize = (pi: ExtensionAPI) =>
    pi.registerToolRenderer((name, next) => {
      const original = next();
      nextCalls(name, original);
      return name.startsWith("web_fetch") && override
        ? {
            renderShell: "default",
            renderCall: () => new Text("custom fetch call", 0, 0),
            renderResult: () => new Text("custom fetch result", 0, 0),
          }
        : original;
    });
  const settingsManager = SettingsManager.inMemory({
    packages: [],
    enableInstallTelemetry: false,
    enableAnalytics: false,
    cacheWarming: "off",
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: fixture.directory,
    agentDir: fixture.directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [webFetch, customize],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd: fixture.directory,
    agentDir: fixture.directory,
    resourceLoader: loader,
    settingsManager,
    modelRuntime: runtime,
    model,
    noTools: "builtin",
    sessionManager: SessionManager.inMemory(fixture.directory),
  });
  const updates: unknown[] = [];
  const ended: unknown[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_update") updates.push(event);
    if (event.type === "tool_execution_end") ended.push(event);
  });
  fixture.single.mockImplementation(async (input: FetchInput, hooks: FetchHooks) => {
    hooks.onProgress?.({ phase: "connecting" });
    hooks.onProgress?.({ phase: "extracting" });
    return outcome(input.url);
  });
  fixture.batch.mockImplementation(async (requests: FetchInput[], hooks: FetchHooks) => {
    const items = requests.map((request) => outcome(request.url));
    const succeeded = items.filter((item) => item.kind !== "error").length;
    hooks.onProgress?.({ phase: "reading", completed: 1, total: items.length });
    return {
      kind: "batch",
      items,
      total: items.length,
      succeeded,
      failed: items.length - succeeded,
      cancelled: false,
      truncated: false,
    };
  });
  try {
    await session.bindExtensions({ mode: "print" });
    expect(session.getActiveToolNames().sort()).toEqual(["web_fetch", "web_fetch_batch"]);
    const definitions = [
      session.getToolDefinition("web_fetch"),
      session.getToolDefinition("web_fetch_batch"),
    ];
    for (const definition of definitions) {
      if (!definition) throw Error("Missing registered tool");
      expect(definition.outputSchema).toBeDefined();
      const execute = definition.execute;
      const resolve = () =>
        session.extensionRunner.resolveToolRenderers(definition.name, () => definition);
      const framed = resolve();
      expect(framed?.renderShell).toBe("self");
      override = true;
      expect(resolve()?.renderShell).toBe("default");
      expect(session.getToolDefinition(definition.name)).toBe(definition);
      expect(definition.execute).toBe(execute);
      override = false;
    }
    expect(nextCalls).toHaveBeenCalled();
    const beforeCommands = turns.mock.calls.length;
    await session.prompt("/personal:web-fetch off");
    expect(session.getActiveToolNames()).toEqual([]);
    await session.prompt("/personal:web-fetch on");
    expect(session.getActiveToolNames().sort()).toEqual(["web_fetch", "web_fetch_batch"]);
    await session.prompt("/personal:web-fetch toggle");
    expect(session.getActiveToolNames()).toEqual([]);
    await session.prompt("/personal:web-fetch");
    expect(session.getActiveToolNames().sort()).toEqual(["web_fetch", "web_fetch_batch"]);
    expect(turns).toHaveBeenCalledTimes(beforeCommands);
    expect(fixture.single).not.toHaveBeenCalled();
    expect(fixture.batch).not.toHaveBeenCalled();
    const testUrl = "https://offline.test/TestPath?Case=Mixed";
    selectedCall = { name: "web_fetch", args: { url: testUrl } };
    let unsubscribe = () => {};
    const tested = new Promise<void>((resolve) => {
      unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_settled") {
          unsubscribe();
          resolve();
        }
      });
    });
    await session.prompt(`/personal:web-fetch test ${testUrl}`);
    await tested;
    expect(fixture.single).toHaveBeenCalledWith(
      expect.objectContaining({ url: testUrl }),
      expect.anything(),
    );
    expect(turns).toHaveBeenCalledTimes(beforeCommands + 2);
    fixture.single.mockClear();
    fixture.batch.mockClear();
    override = true;
    for (const [name, args, expectedError, expectedStructured] of [
      [
        "web_fetch",
        { url: "https://offline.test/article" },
        false,
        { kind: "content", title: "Offline article" },
      ],
      [
        "web_fetch",
        { url: "https://offline.test/failure" },
        true,
        { kind: "error", code: "timeout" },
      ],
      [
        "web_fetch_batch",
        {
          requests: [
            { url: "https://offline.test/article" },
            { url: "https://offline.test/failure" },
          ],
        },
        false,
        { kind: "batch", succeeded: 1, failed: 1 },
      ],
      [
        "web_fetch_batch",
        { requests: [{ url: "https://offline.test/failure" }] },
        true,
        { kind: "batch", succeeded: 0, failed: 1 },
      ],
    ] as const) {
      selectedCall = { name, args };
      expect(
        session.extensionRunner.resolveToolRenderers(name, () => session.getToolDefinition(name))
          ?.renderShell,
      ).toBe("default");
      await session.prompt("Run offline fixture");
      const result = [...session.messages]
        .reverse()
        .find((message) => message.role === "toolResult");
      expect(result).toMatchObject({
        toolName: name,
        isError: expectedError,
        details: { version: 1, status: expectedError ? "error" : "done" },
      });
      // Pi keeps structuredContent on execution results for callers, not persisted model history.
      expect(ended.at(-1)).toMatchObject({
        toolName: name,
        isError: expectedError,
        result: { structuredContent: expectedStructured },
      });
    }
    override = false;
    expect(fixture.single).toHaveBeenCalledTimes(2);
    expect(fixture.batch).toHaveBeenCalledTimes(2);
    expect(updates.length).toBeGreaterThan(0);
    // Public ToolExecutionComponent drops structuredContent from renderer input: prove content/details fallback.
    const definition = definitions[0]!;
    const resolved = session.extensionRunner.resolveToolRenderers("web_fetch", () => definition);
    const terminal: Terminal = {
      start() {},
      stop() {},
      async drainInput() {},
      write() {},
      get columns() {
        return 80;
      },
      get rows() {
        return 24;
      },
      kittyProtocolActive: false,
      moveBy() {},
      hideCursor() {},
      showCursor() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      setTitle() {},
      setProgress() {},
      setProgramStatus() {},
    };
    const tui = new TuiMainScreen(terminal);
    const row = new ToolExecutionComponent(
      "web_fetch",
      "render-probe",
      { url: "https://offline.test/article" },
      {},
      resolved,
      tui,
      fixture.directory,
    );
    row.updateResult({
      content: [
        {
          type: "text",
          text: "Source: https://offline.test/article\nFinal source: https://offline.test/final\nHTTP: 200 · text/html\nTitle: Offline article\nTruncated: false\n\nFetched article preview\nsecond preview line\nexpanded final line",
        },
      ],
      details: {
        version: 1,
        status: "done",
        succeeded: 1,
        failed: 0,
        total: 1,
        completed: 1,
        truncated: false,
      },
      isError: false,
    });
    for (const width of [1, 5, 40, 80])
      for (const line of row.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(row.render(80).join("\n")).toContain("Fetched article preview");
    expect(row.render(80).join("\n")).not.toContain("expanded final line");
    row.setExpanded(true);
    expect(row.render(80).join("\n")).toContain("expanded final line");
    // Malformed extra fields are rejected by Pi before either mocked core entry point is called.
    const callsBefore = fixture.single.mock.calls.length;
    selectedCall = {
      name: "web_fetch",
      args: { url: "https://offline.test/article", headers: { Authorization: "fixture-secret" } },
    };
    await session.prompt("Reject extra fixture field");
    expect(
      [...session.messages].reverse().find((message) => message.role === "toolResult"),
    ).toMatchObject({ isError: true, toolName: "web_fetch" });
    expect(fixture.single).toHaveBeenCalledTimes(callsBefore);
    // Abort through the real host; core returns a terminal cancelled batch instead of losing item states.
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    fixture.batch.mockImplementation(async (requests: FetchInput[], hooks: FetchHooks) => {
      started();
      await new Promise<void>((resolve) => {
        if (hooks.signal?.aborted) resolve();
        else hooks.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        kind: "batch",
        items: requests.map((request) => ({
          kind: "error",
          url: request.url,
          code: "cancelled",
          message: "cancelled",
        })),
        total: requests.length,
        succeeded: 0,
        failed: requests.length,
        cancelled: true,
        truncated: false,
      };
    });
    selectedCall = {
      name: "web_fetch_batch",
      args: { requests: [{ url: "https://offline.test/cancel" }] },
    };
    const running = session.prompt("Cancel offline fixture");
    await began;
    await session.abort();
    await running;
    expect(
      [...session.messages].reverse().find((message) => message.role === "toolResult"),
    ).toMatchObject({
      toolName: "web_fetch_batch",
      isError: true,
      details: { status: "error", failed: 1 },
    });
    expect(ended.at(-1)).toMatchObject({
      result: {
        structuredContent: {
          cancelled: true,
          failed: 1,
          items: [{ kind: "error", code: "cancelled" }],
        },
      },
    });
  } finally {
    session.dispose();
  }
});
