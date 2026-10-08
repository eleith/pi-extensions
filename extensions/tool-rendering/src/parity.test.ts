import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, expect, it, vi } from "vitest";
import {
  InMemoryModelsStore,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type AgentToolResult,
  type ToolDefinition,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import toolRendering from "./index.ts";
import { getImageDimensions } from "@earendil-works/pi-tui";

const directory = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "render-parity-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  vi.stubEnv("PI_OFFLINE", "1");
  return dir;
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function fixture(
  enabled: boolean,
  options: {
    tools?: string[];
    noTools?: "all" | "builtin";
    customTools?: ToolDefinition[];
    images?: boolean;
    cwd?: string;
    shellPath?: string;
    shellCommandPrefix?: string;
    factories?: ExtensionFactory[];
  } = {},
) {
  const forbidden = vi.fn(() => {
    throw Error("Provider calls/credential persistence forbidden");
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: forbidden,
      delete: forbidden,
    },
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  let request:
    | { name: string; args: unknown; options?: Parameters<ExtensionToolContext["executeTool"]>[2] }
    | undefined;
  let nested: Awaited<ReturnType<ExtensionToolContext["executeTool"]>> | undefined;
  let followup = false;
  const modelInputs: Context[] = [];
  const streamSimple = (_model: unknown, context: Context) => {
    modelInputs.push(structuredClone(context));
    const stream = createAssistantMessageEventStream();
    const call = request;
    if (!call && !followup) throw Error("Unexpected model call forbidden");
    const message: AssistantMessage = {
      role: "assistant",
      provider: "parity-fixture",
      api: "parity-fixture",
      model: "fake",
      content: call
        ? [
            {
              type: "toolCall",
              id: "disposable-parent",
              name: "fixture-driver",
              arguments: { command: "disposable" },
            },
          ]
        : [{ type: "text", text: "done" }],
      stopReason: call ? "toolUse" : "stop",
      timestamp: 1,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    followup = Boolean(call);
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    return stream;
  };
  modelRuntime.registerProvider("parity-fixture", {
    api: "parity-fixture",
    baseUrl: "https://never-connect.invalid",
    apiKey: "disposable-not-real",
    models: [
      {
        id: "fake",
        name: "Fake",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1000,
      },
    ],
    streamSimple,
  });
  const driver = {
    ...createBashToolDefinition(options.cwd ?? directory),
    name: "fixture-driver",
    exposure: "model-only",
    async execute(
      _id: string,
      _args: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) {
      if (!request) throw Error("No fixture request");
      const call = request;
      request = undefined;
      nested = await ctx.executeTool(call.name, call.args, call.options);
      return { ...nested.result, isError: nested.isError };
    },
  } as ToolDefinition;
  const settingsManager = SettingsManager.inMemory({
    packages: [],
    enableInstallTelemetry: false,
    enableAnalytics: false,
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: { enabled: false },
    images: { autoResize: options.images ?? true },
    shellPath: options.shellPath,
    shellCommandPrefix: options.shellCommandPrefix,
  });
  const cwd = options.cwd ?? directory;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [...(enabled ? [toolRendering] : []), ...(options.factories ?? [])],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd,
    agentDir: directory,
    resourceLoader: loader,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    model: modelRuntime.getModel("parity-fixture", "fake"),
    tools: options.tools ? [...options.tools, "fixture-driver"] : undefined,
    noTools: options.noTools,
    customTools: [...(options.customTools ?? []), driver],
  });
  await session.bindExtensions({ mode: "print" });
  const ctx = {
    async executeTool(
      name: string,
      args: unknown,
      options?: Parameters<ExtensionToolContext["executeTool"]>[2],
    ) {
      request = { name, args, options };
      nested = undefined;
      await session.prompt("Run disposable fixture");
      const result = nested as Awaited<ReturnType<ExtensionToolContext["executeTool"]>> | undefined;
      if (!result) throw Error("Fixture tool did not execute");
      return result;
    },
  };
  return {
    session,
    ctx,
    forbidden,
    modelInputs,
    async close() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    },
  };
}

function metadata(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    active: f.session.getActiveToolNames(),
    prompt: f.session.systemPrompt,
    all: f.session.getAllTools(),
    declared: f.session.agent.state.tools.map(({ execute: _execute, ...tool }) => tool),
  };
}

it.each([
  { tools: ["bash", "read", "grep", "ls", "find", "write", "edit"] },
  { tools: ["read"] },
  { noTools: "all" as const },
  { noTools: "builtin" as const },
])("does not alter SDK configured loadout/schemas/prompts: %j", async (options) => {
  const baseline = await fixture(false, options),
    framed = await fixture(true, options);
  try {
    expect(metadata(framed)).toEqual(metadata(baseline));
    expect(framed.forbidden).not.toHaveBeenCalled();
  } finally {
    await baseline.close();
    await framed.close();
  }
});

it("preserves custom same-name execution, tool-result hooks and downstream resolver bundles", async () => {
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "custom executed" }],
    details: { sentinel: 1 },
  }));
  const custom = {
    ...createBashToolDefinition(directory),
    description: "Custom same-name bash",
    annotations: { readOnlyHint: true },
    promptSnippet: "Custom sentinel",
    execute,
  } as unknown as ToolDefinition;
  const downstream = { renderShell: "default" as const };
  const next = vi.fn();
  const hooks = vi.fn();
  const additional: ExtensionFactory = (pi) => {
    pi.registerToolRenderer((name, fallback) => {
      next(name);
      return name === "bash" ? downstream : fallback();
    });
    pi.on("tool_result", (event) => {
      hooks(event.toolName);
      return { content: [...event.content, { type: "text", text: "hook sentinel" }] };
    });
  };
  const f = await fixture(true, {
    customTools: [custom],
    noTools: "builtin",
    factories: [additional],
  });
  try {
    expect(f.session.getActiveToolNames()).toEqual(["bash", "fixture-driver"]);
    expect(
      f.session.extensionRunner.resolveToolRenderers("bash", () => undefined)?.renderShell,
    ).toBe("self");
    expect(next).not.toHaveBeenCalled();
    const result = await f.ctx.executeTool("bash", { command: "unused" });
    expect(execute).toHaveBeenCalledOnce();
    expect(hooks).toHaveBeenCalledWith("bash");
    expect(result.result.content).toEqual([
      { type: "text", text: "custom executed" },
      { type: "text", text: "hook sentinel" },
    ]);
    await f.session.prompt("/eleith:tool-rendering hide");
    expect(f.session.extensionRunner.resolveToolRenderers("bash", () => undefined)).toBe(
      downstream,
    );
    expect(next).toHaveBeenCalledWith("bash");
    expect(
      f.session.extensionRunner.resolveToolRenderers("unrelated", () => undefined),
    ).toBeUndefined();
    expect(f.forbidden).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("preserves configured shell executable/prefix, cwd, streaming, abort, timeout and nonzero results", async () => {
  const cwd = mkdtempSync(join(directory, "shell-"));
  const shellPath = join(cwd, "configured-shell");
  writeFileSync(shellPath, '#!/bin/sh\nexport SHELL_SENTINEL=custom-shell\nexec /bin/bash "$@"\n');
  chmodSync(shellPath, 0o700);
  const settings = {
    cwd,
    shellPath,
    shellCommandPrefix: "export PREFIX_SENTINEL=prefix;",
    tools: ["bash"],
  };
  const baseline = await fixture(false, settings),
    framed = await fixture(true, settings);
  try {
    for (const args of [
      { command: 'printf "%s|%s|%s" "$SHELL_SENTINEL" "$PREFIX_SENTINEL" "$PWD"' },
      { command: "printf failure; exit 7" },
      { command: "sleep 5", timeout: 0.05 },
    ]) {
      const a = await baseline.ctx.executeTool("bash", args),
        b = await framed.ctx.executeTool("bash", args);
      expect(b.isError).toBe(a.isError);
      expect(b.result.content).toEqual(a.result.content);
      expect(b.result.details).toEqual(a.result.details);
      if (args.command.startsWith('printf "'))
        expect(JSON.stringify(b.result.content)).toContain(`custom-shell|prefix|${cwd}`);
    }
    for (const f of [baseline, framed]) {
      const signal = new AbortController();
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        signal.abort();
      }, 5_000);
      const onUpdate = vi.fn((update: AgentToolResult<unknown>) => {
        if (
          update.content.some((block) => block.type === "text" && block.text.includes("partial"))
        ) {
          clearTimeout(deadline);
          signal.abort();
        }
      });
      try {
        const result = await f.ctx.executeTool(
          "bash",
          { command: "printf partial; sleep 5" },
          { signal: signal.signal, onUpdate },
        );
        expect(timedOut).toBe(false);
        expect(signal.signal.aborted).toBe(true);
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.result.content)).toContain("partial");
        expect(onUpdate).toHaveBeenCalled();
        expect(f.forbidden).not.toHaveBeenCalled();
      } finally {
        clearTimeout(deadline);
        signal.abort();
      }
    }
  } finally {
    await baseline.close();
    await framed.close();
  }
}, 20_000);

it("leaves new ls/find execution results untouched, without additive rendering details", async () => {
  const cwd = mkdtempSync(join(directory, "paths-"));
  writeFileSync(join(cwd, "odd name.txt"), "one");
  writeFileSync(join(cwd, "two.txt"), "two");
  const baseline = await fixture(false, { cwd, tools: ["ls", "find"] }),
    framed = await fixture(true, { cwd, tools: ["ls", "find"] });
  try {
    for (const name of ["ls", "find"]) {
      const args = name === "ls" ? { path: "." } : { pattern: "*.txt", path: "." };
      const a = await baseline.ctx.executeTool(name, args),
        b = await framed.ctx.executeTool(name, args);
      expect(b.result).toEqual(a.result);
      expect(b.isError).toBe(false);
      expect(b.result.details ?? {}).not.toHaveProperty("rendering");
    }
  } finally {
    await baseline.close();
    await framed.close();
  }
});

// Generated large PNG, no committed image or user files. CRC covers the PNG chunk bytes.
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, content, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 3 + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

it.each([true, false])(
  "preserves configured read image resizing (%s) on a generated large image",
  async (images) => {
    const cwd = mkdtempSync(join(directory, "image-"));
    writeFileSync(join(cwd, "generated.png"), png(3000, 2200));
    const baseline = await fixture(false, { cwd, tools: ["read"], images }),
      framed = await fixture(true, { cwd, tools: ["read"], images });
    try {
      const a = await baseline.ctx.executeTool("read", { path: "generated.png" }),
        b = await framed.ctx.executeTool("read", { path: "generated.png" });
      expect(b.result).toEqual(a.result);
      expect(b.isError).toBe(false);
      expect(b.result.content.some((block) => block.type === "image")).toBe(true);
      const dimensions = (result: typeof b.result) =>
        result.content.flatMap((block) =>
          block.type === "image" ? [getImageDimensions(block.data, block.mimeType)] : [],
        );
      expect(dimensions(b.result)).toEqual(dimensions(a.result));
      expect(dimensions(b.result)[0]?.widthPx).toBe(images ? 2000 : 3000);
      const lastA = baseline.modelInputs
        .at(-1)
        ?.messages.filter((message) => message.role === "toolResult");
      const lastB = framed.modelInputs
        .at(-1)
        ?.messages.filter((message) => message.role === "toolResult");
      const modelContent = (messages: typeof lastA) =>
        messages?.map(({ toolName, toolCallId, content, isError }) => ({
          toolName,
          toolCallId,
          content,
          isError,
        }));
      expect(modelContent(lastB)).toEqual(modelContent(lastA));
      expect(framed.forbidden).not.toHaveBeenCalled();
    } finally {
      await baseline.close();
      await framed.close();
    }
  },
  20_000,
);
