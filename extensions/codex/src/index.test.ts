import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterAll, expect, it, vi } from "vitest";
import codex from "./index.ts";
import { fetchCodexModelCatalog, fetchCodexUsage, readCodexAuthScope } from "./client.ts";

vi.mock("./client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.ts")>()),
  fetchCodexUsage: vi.fn(),
  fetchCodexModelCatalog: vi.fn(),
  readCodexAuthScope: vi.fn(),
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

async function load(prefix = "eleith") {
  vi.mocked(fetchCodexUsage).mockReset();
  vi.mocked(fetchCodexModelCatalog).mockReset();
  vi.mocked(readCodexAuthScope).mockReset();
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
  const ctx = {
    mode: "print",
    model: undefined,
    hasUI: false,
    isIdle: () => true,
    getContextUsage: () => undefined,
    modelRegistry: {},
    ui: { notify, confirm: vi.fn(async () => false) },
    sessionManager: { getBranch: () => [], getSessionId: () => "session", getLeafId: () => null },
  } as unknown as ExtensionCommandContext;
  await codex(pi as unknown as ExtensionAPI);
  return {
    pi,
    ctx,
    notify,
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
  expect(await context.command().getArgumentCompletions?.("e")).toEqual([
    { value: "extend", label: "extend" },
  ]);
  expect(await context.command().getArgumentCompletions?.("")).toEqual([
    { value: "extend", label: "extend" },
    { value: "restore", label: "restore" },
    { value: "usage", label: "usage" },
    { value: "fast", label: "fast" },
  ]);
});

it("handles no argument as status rather than an invalid default action", async () => {
  const context = await load();
  await context.emit("session_start");
  await context.command().handler("", context.ctx);
  expect(context.notify).toHaveBeenLastCalledWith("No model selected.", "info");
  expect(context.pi.setModel).not.toHaveBeenCalled();
  await context.command().handler("extend restore", context.ctx);
  expect(context.notify).toHaveBeenLastCalledWith(
    "Usage: /eleith:codex [extend|restore|usage|fast]",
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
  expect(readCodexAuthScope).not.toHaveBeenCalled();
});

it("routes fast subcommands without allowing trailing arguments on other actions", async () => {
  const context = await load("personal");
  await context.emit("session_start");
  await context.command().handler("fast status", context.ctx);
  expect(context.notify).toHaveBeenLastCalledWith("No model selected.", "info");
  await context.command().handler("fast off extra", context.ctx);
  expect(context.notify).toHaveBeenLastCalledWith(
    "Usage: /personal:codex fast [on|off|toggle|status|reset]",
    "warning",
  );
  await context.command().handler("restore extra", context.ctx);
  expect(context.notify).toHaveBeenLastCalledWith(
    "Usage: /personal:codex [extend|restore|usage|fast]",
    "warning",
  );
  expect(fetchCodexModelCatalog).not.toHaveBeenCalled();
  expect(readCodexAuthScope).not.toHaveBeenCalled();
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
  expect(context.notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Plan: plus"),
    "info",
  );
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
    expect(context.notify).not.toHaveBeenCalled();
  },
);

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
