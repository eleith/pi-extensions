import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import codex from "./index.ts";
import { fetchCodexModelCatalog, fetchCodexUsage } from "./client.ts";
import { customInteractionUI } from "./custom-interaction.test-helper.ts";

vi.mock("./client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.ts")>()),
  fetchCodexUsage: vi.fn(),
  fetchCodexModelCatalog: vi.fn(),
}));

const directory = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "codex-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});
const configPath = join(directory, "extensions", "eleith.json");
mkdirSync(join(directory, "extensions"));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

initTheme("dark", false);
const surfaces: ReturnType<typeof customInteractionUI>[] = [];
afterEach(() => {
  for (const surface of surfaces.splice(0)) surface.dispose();
});

async function load(prefix = "eleith", mode: ExtensionCommandContext["mode"] = "print") {
  vi.mocked(fetchCodexUsage).mockReset();
  vi.mocked(fetchCodexModelCatalog).mockReset();
  writeFileSync(configPath, JSON.stringify({ commandPrefix: prefix }));
  type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
  type Listener = (
    event: { type: string; streamingBehavior?: string },
    ctx: ExtensionCommandContext,
  ) => void | Promise<void>;
  const listeners = new Map<string, Listener[]>();
  const pi = {
    on: vi.fn((name: string, handler: Listener) => {
      const handlers = listeners.get(name) ?? [];
      handlers.push(handler);
      listeners.set(name, handlers);
      return () => {};
    }),
    getCommands: vi.fn(() => []),
    registerCommand: vi.fn((_name: string, _command: Command) => {}),
    setModel: vi.fn(async () => false),
    getThinkingLevel: vi.fn(() => "high"),
    setThinkingLevel: vi.fn(),
    appendEntry: vi.fn(),
  };
  const notify = vi.fn();
  const surface = customInteractionUI();
  surfaces.push(surface);
  const ctx = {
    mode,
    model: undefined,
    hasUI: mode === "tui" || mode === "rpc",
    isIdle: () => true,
    getContextUsage: () => undefined,
    modelRegistry: {},
    ui: { notify, confirm: vi.fn(async () => false), custom: surface.custom },
    sessionManager: { getBranch: () => [], getSessionId: () => "session", getLeafId: () => null },
  } as unknown as ExtensionCommandContext;
  await codex(pi as unknown as ExtensionAPI);
  return {
    pi,
    ctx,
    notify,
    surface,
    async emit(type: string) {
      for (const handler of listeners.get(type) ?? []) await handler({ type }, ctx);
    },
    command() {
      const command = pi.registerCommand.mock.calls[0]?.[1];
      if (!command) throw new Error("Command has not been registered");
      return command;
    },
  };
}

it("registers only the configured native command once after binding", async () => {
  const context = await load("personal");
  expect(context.pi.getCommands).not.toHaveBeenCalled();
  expect(context.pi.registerCommand).not.toHaveBeenCalled();
  await context.emit("session_start");
  await context.emit("session_start");
  expect(context.pi.registerCommand).toHaveBeenCalledTimes(1);
  expect(context.pi.registerCommand.mock.calls[0]?.[0]).toBe("personal:codex");
  expect(await context.command().getArgumentCompletions?.("c")).toEqual([
    expect.objectContaining({
      value: "context",
      label: "context",
      description: expect.any(String),
    }),
  ]);
  const rootChoices = await context.command().getArgumentCompletions?.("");
  expect(rootChoices?.map(({ value }) => value)).toEqual(["context", "fast", "usage"]);
  expect(await context.command().getArgumentCompletions?.("fast o")).toEqual([
    expect.objectContaining({
      value: "fast on",
      description: expect.stringContaining("allowance"),
    }),
    expect.objectContaining({
      value: "fast off",
      description: expect.stringContaining("standard"),
    }),
  ]);
});

it("handles no argument as status rather than an invalid default action", async () => {
  const context = await load();
  await context.emit("session_start");
  for (const input of ["", "context", "fast"]) {
    await context.command().handler(input, context.ctx);
    expect(context.notify).toHaveBeenLastCalledWith("No model selected.", "info");
  }
  expect(context.pi.setModel).not.toHaveBeenCalled();
  await context.command().handler("extend restore", context.ctx);
  expect(context.notify).toHaveBeenLastCalledWith(
    "Usage: /eleith:codex [context|fast|usage]",
    "warning",
  );
});

it("wires restore/reconcile hooks without provider calls for an unsupported model", async () => {
  const context = await load();
  for (const event of [
    "session_start",
    "session_tree",
    "model_select",
    "input",
    "session_shutdown",
  ])
    await context.emit(event);
  expect(context.pi.setModel).not.toHaveBeenCalled();
  expect(context.pi.appendEntry).not.toHaveBeenCalled();
  expect(context.pi.on.mock.calls.map(([name]) => name)).not.toContain("before_agent_start");
  expect(fetchCodexUsage).not.toHaveBeenCalled();
  expect(fetchCodexModelCatalog).not.toHaveBeenCalled();
});

it("rejects removed commands and additional control arguments without side effects", async () => {
  const context = await load("personal");
  await context.emit("session_start");
  const rootUsage = "Usage: /personal:codex [context|fast|usage]";
  const cases = [
    ["extend", rootUsage],
    ["restore", rootUsage],
    ["usage extra", rootUsage],
    ["fast status", "Usage: /personal:codex fast [on|off|toggle]"],
    ["fast reset", "Usage: /personal:codex fast [on|off|toggle]"],
    ["fast off extra", "Usage: /personal:codex fast [on|off|toggle]"],
    ["context status", "Usage: /personal:codex context [on|off|toggle]"],
    ["context on extra", "Usage: /personal:codex context [on|off|toggle]"],
  ] as const;
  for (const [input, usage] of cases) {
    await context.command().handler(input, context.ctx);
    expect(context.notify).toHaveBeenLastCalledWith(usage, "warning");
  }
  expect(fetchCodexModelCatalog).not.toHaveBeenCalled();
  expect(fetchCodexUsage).not.toHaveBeenCalled();
  expect(context.pi.appendEntry).not.toHaveBeenCalled();
  expect(context.pi.setModel).not.toHaveBeenCalled();
});

it("routes usage through the configured command without requiring an idle Codex selection", async () => {
  const context = await load("personal");
  vi.mocked(fetchCodexUsage).mockResolvedValue({ plan_type: "plus" });
  await context.emit("session_start");
  await context.command().handler("usage extra", context.ctx);
  expect(fetchCodexUsage).not.toHaveBeenCalled();
  context.notify.mockClear();
  await context.command().handler("usage", { ...context.ctx, isIdle: () => false });
  expect(fetchCodexUsage).toHaveBeenCalledExactlyOnceWith(
    context.ctx.modelRegistry,
    expect.any(AbortSignal),
  );
  expect(context.notify).toHaveBeenNthCalledWith(1, "Fetching Codex usage…", "info");
  expect(context.notify).toHaveBeenLastCalledWith(expect.stringContaining("Plan: plus"), "info");
  expect(context.notify).toHaveBeenCalledTimes(2);
  expect(context.pi.setModel).not.toHaveBeenCalled();
  expect(context.pi.appendEntry).not.toHaveBeenCalled();
});

it.each(["model_select", "session_tree", "session_shutdown"])(
  "%s cancels a pending usage report instead of displaying a late reply",
  async (event) => {
    const context = await load();
    let finish!: (value: unknown) => void;
    vi.mocked(fetchCodexUsage).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await context.emit("session_start");
    const request = context.command().handler("usage", context.ctx);
    const signal = vi.mocked(fetchCodexUsage).mock.calls[0][1]!;
    await context.emit(event);
    expect(signal.aborted).toBe(true);
    finish({ plan_type: "plus" });
    await request;
    expect(context.notify).toHaveBeenCalledExactlyOnceWith("Fetching Codex usage…", "info");
  },
);

it("combines context and fast mode in a read-only dashboard with the configured command hints", async () => {
  const context = await load("personal");
  await context.emit("session_start");
  const model: Model<Api> = {
    id: "gpt-6-sol",
    name: "Sol",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  };
  const getProviderAuth = vi.fn(async () => {
    throw new Error("Auth lookup forbidden");
  });
  const ctx = {
    ...context.ctx,
    model,
    modelRegistry: {
      find: () => model,
      getProvider: () => ({ baseUrl: model.baseUrl }),
      isUsingOAuth: () => true,
      getRegisteredProviderConfig: () => undefined,
      getRegisteredNativeProvider: () => undefined,
      getProviderAuth,
    },
  } as unknown as ExtensionCommandContext;
  await context.command().handler("", ctx);
  expect(context.notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Fast: Provider default (no override)"),
    "info",
  );
  expect(context.notify).toHaveBeenLastCalledWith(expect.stringContaining("Context:"), "info");
  expect(context.notify).toHaveBeenLastCalledWith(
    expect.stringContaining("/personal:codex fast"),
    "info",
  );
  expect(getProviderAuth).not.toHaveBeenCalled();
  expect(fetchCodexUsage).not.toHaveBeenCalled();
  expect(fetchCodexModelCatalog).not.toHaveBeenCalled();
  expect(context.pi.appendEntry).not.toHaveBeenCalled();
  expect(context.pi.setModel).not.toHaveBeenCalled();
  const dashboard = context.notify.mock.calls[0][0];
  for (const input of ["context", "fast"]) {
    await context.command().handler(input, ctx);
    expect(context.notify).toHaveBeenLastCalledWith(dashboard, "info");
  }
  expect(context.notify).toHaveBeenCalledTimes(3);
  expect(getProviderAuth).not.toHaveBeenCalled();
  expect(fetchCodexUsage).not.toHaveBeenCalled();
  expect(fetchCodexModelCatalog).not.toHaveBeenCalled();
  expect(context.pi.appendEntry).not.toHaveBeenCalled();
  expect(context.pi.setModel).not.toHaveBeenCalled();
  await context.emit("session_shutdown");
  const notify = context.notify;
  Object.defineProperty(ctx, "ui", {
    get: () => {
      throw new Error("Expired UI");
    },
  });
  for (const input of ["", "context", "fast"]) await context.command().handler(input, ctx);
  expect(notify).toHaveBeenCalledTimes(3);
});

it("fails invalid prefix settings before registering any capabilities", async () => {
  writeFileSync(configPath, '{"commandPrefix":"Invalid Prefix"}');
  const on = vi.fn(),
    registerCommand = vi.fn();
  await expect(codex({ on, registerCommand } as unknown as ExtensionAPI)).rejects.toThrow(
    configPath,
  );
  expect(on).not.toHaveBeenCalled();
  expect(registerCommand).not.toHaveBeenCalled();
});

it("routes every TUI read-only alias to the shared overview inspector, not notifications", async () => {
  const context = await load("personal", "tui");
  await context.emit("session_start");
  for (const [index, input] of ["", "context", "fast"].entries()) {
    let settled = false;
    const request = Promise.resolve(context.command().handler(input, context.ctx)).then(() => {
      settled = true;
    });
    await flush();
    const modal = context.surface.modals[index];
    expect(modal.lines.join("\n")).toContain("Codex · Overview");
    expect(modal.lines.join("\n")).toContain("No model selected.");
    expect(modal.closed).toBe(false);
    expect(settled).toBe(false);
    modal.component!.handleInput!(index === 1 ? "\u001b" : "\r");
    await request;
    expect(modal.close).toHaveBeenCalledOnce();
  }
  expect(context.surface.custom).toHaveBeenCalledTimes(3);
  expect(context.notify).not.toHaveBeenCalled();
  expect(fetchCodexUsage).not.toHaveBeenCalled();
  expect(fetchCodexModelCatalog).not.toHaveBeenCalled();
  expect(context.pi.setModel).not.toHaveBeenCalled();
  expect(context.pi.appendEntry).not.toHaveBeenCalled();
  await context.emit("session_shutdown");
});

it("shares TUI inspector ownership between dashboard aliases and account usage", async () => {
  const context = await load("personal", "tui");
  let finish!: (data: unknown) => void;
  vi.mocked(fetchCodexUsage).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await context.emit("session_start");
  const usage = context.command().handler("usage", context.ctx);
  await flush();
  const signal = vi.mocked(fetchCodexUsage).mock.calls[0][1]!;
  const dashboard = context.command().handler("fast", context.ctx);
  await usage; // Cancels an uncooperative fetch without waiting for its response.
  await flush();
  expect(signal.aborted).toBe(true);
  expect(context.surface.modals[0].closed).toBe(true);
  expect(context.surface.modals[1].lines.join("\n")).toContain("Codex · Overview");
  vi.mocked(fetchCodexUsage).mockResolvedValueOnce({ plan_type: "plus" });
  const nextUsage = context.command().handler("usage", context.ctx);
  await dashboard;
  await flush();
  const modal = context.surface.modals[2];
  expect(context.surface.modals[1].closed).toBe(true);
  expect(modal.lines.join("\n")).toContain("Codex · Usage");
  expect(modal.lines.join("\n")).toContain("Plan: plus");
  expect(modal.closed).toBe(false);
  expect(context.surface.focusedComponent).toBe(modal.component);
  finish({ plan_type: "stale-plan" });
  await flush();
  expect(modal.lines.join("\n")).not.toContain("stale-plan");
  modal.component!.handleInput!("\r");
  await nextUsage;
  expect(context.notify).not.toHaveBeenCalled();
  expect(context.pi.appendEntry).not.toHaveBeenCalled();
  expect(context.pi.setModel).not.toHaveBeenCalled();
  await context.emit("session_shutdown");
});

it.each(["model_select", "session_tree", "session_shutdown"])(
  "%s cancels a ready TUI overview as well as usage inspectors",
  async (event) => {
    const context = await load("eleith", "tui");
    await context.emit("session_start");
    const request = context.command().handler("context", context.ctx);
    await flush();
    const modal = context.surface.modals[0];
    expect(modal.closed).toBe(false);
    await context.emit(event);
    await request;
    expect(modal.closed).toBe(true);
    expect(modal.close).toHaveBeenCalledOnce();
    expect(context.surface.focusedComponent).toBe(context.surface.mainEditor);
    expect(context.notify).not.toHaveBeenCalled();
    if (event !== "session_shutdown") await context.emit("session_shutdown");
  },
);

it("keeps TUI mutation feedback and invalid-argument notifications outside inspectors", async () => {
  const context = await load("eleith", "tui");
  await context.emit("session_start");
  await context.command().handler("context on", context.ctx);
  expect(context.notify).toHaveBeenCalled();
  context.notify.mockClear();
  await context.command().handler("fast on", context.ctx);
  expect(context.notify).toHaveBeenCalled();
  context.notify.mockClear();
  await context.command().handler("usage extra", context.ctx);
  expect(context.notify).toHaveBeenCalledExactlyOnceWith(
    "Usage: /eleith:codex [context|fast|usage]",
    "warning",
  );
  expect(context.surface.custom).not.toHaveBeenCalled();
  expect(fetchCodexUsage).not.toHaveBeenCalled();
  expect(fetchCodexModelCatalog).not.toHaveBeenCalled();
  expect(context.pi.appendEntry).not.toHaveBeenCalled();
  await context.emit("session_shutdown");
});

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
