import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import toolRendering from "./index.ts";

const directory = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "tool-rendering-index-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});
mkdirSync(join(directory, "extensions"));
const path = join(directory, "extensions", "eleith.json");
beforeEach(() => {
  rmSync(path, { force: true });
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

async function load(prefix = "eleith", conflicts: { name: string }[] = []) {
  writeFileSync(path, JSON.stringify({ commandPrefix: prefix }));
  type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
  type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => void | Promise<void>;
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const api = {
    on: vi.fn((name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {};
    }),
    registerTool: vi.fn((tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    }),
    registerCommand: vi.fn((_name: string, _command: Command) => {}),
    getCommands: vi.fn(() => conflicts),
  };
  const notify = vi.fn(),
    setWorkingMessage = vi.fn();
  const ctx = {
    mode: "tui",
    ui: { notify, setWorkingMessage },
  } as unknown as ExtensionCommandContext;
  await toolRendering(api as unknown as ExtensionAPI);
  return {
    api,
    tools,
    ctx,
    notify,
    async emit(type: string, event: Record<string, unknown> = {}) {
      for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
    },
    command() {
      const value = api.registerCommand.mock.calls[0]?.[1];
      if (!value) throw Error("Command not registered");
      return value;
    },
  };
}

function readCall(tools: Map<string, ToolDefinition>): string {
  const args = { path: "example.txt" };
  const context: Parameters<NonNullable<ToolDefinition["renderCall"]>>[2] = {
    args,
    toolCallId: "read-test",
    lastComponent: undefined,
    state: {},
    cwd: directory,
    executionStarted: false,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: true,
    isError: false,
    invalidate() {},
  };
  const component = tools.get("read")?.renderCall?.(args, theme, context);
  if (!component) throw Error("Read renderer missing");
  return component.render(80).map(stripTerminalSequences).join("\n");
}

it("registers all seven built-in definitions, with execution and schema intact", async () => {
  const tree = await load();
  expect([...tree.tools.keys()]).toEqual(["bash", "read", "grep", "ls", "find", "write", "edit"]);
  for (const tool of tree.tools.values()) {
    expect(tool.renderShell).toBe("self");
    expect(tool.execute).toBeTypeOf("function");
    expect(tool.parameters).toHaveProperty("properties");
    expect(tool.description).not.toBe("");
  }
  await tree.emit("session_shutdown");
});

it("registers a prefixed native command once and completes show/hide/toggle", async () => {
  const tree = await load("personal");
  await tree.emit("session_start");
  await tree.emit("session_start");
  expect(tree.api.registerCommand).toHaveBeenCalledTimes(1);
  expect(tree.api.registerCommand.mock.calls[0][0]).toBe("personal:tool-rendering");
  expect(tree.command().getArgumentCompletions?.("h")).toEqual([{ value: "hide", label: "hide" }]);
  await tree.emit("session_shutdown");
});

it("commands toggle only this factory's renderers; a reloaded factory starts enabled", async () => {
  const first = await load();
  await first.emit("session_start");
  expect(readCall(first.tools)).toContain("── read");
  await first.command().handler("hide", first.ctx);
  expect(readCall(first.tools)).not.toContain("──");
  expect(first.notify).toHaveBeenLastCalledWith("Tool rendering chrome: hidden", "info");
  const second = await load();
  await second.emit("session_start");
  expect(readCall(second.tools)).toContain("── read");
  await first.command().handler(" SHOW ", first.ctx);
  expect(readCall(first.tools)).toContain("── read");
  await first.command().handler("", first.ctx);
  expect(readCall(first.tools)).not.toContain("──");
  await first.command().handler("toggle", first.ctx);
  expect(readCall(first.tools)).toContain("── read");
  await first.command().handler("show hide", first.ctx);
  expect(first.notify).toHaveBeenLastCalledWith(
    "Usage: /eleith:tool-rendering [show|hide|toggle]",
    "warning",
  );
  await first.emit("session_shutdown");
  await second.emit("session_shutdown");
});

it("warns instead of replacing a conflicting command", async () => {
  const tree = await load("eleith", [{ name: "eleith:tool-rendering" }]);
  await tree.emit("session_start");
  expect(tree.api.registerCommand).not.toHaveBeenCalled();
  expect(tree.notify).toHaveBeenCalledWith(
    expect.stringContaining("was not registered"),
    "warning",
  );
  await tree.emit("session_shutdown");
});

it("rejects invalid settings before registering tools or hooks", async () => {
  writeFileSync(path, '{"commandPrefix":"Invalid Prefix"}');
  const on = vi.fn(),
    registerTool = vi.fn();
  await expect(toolRendering({ on, registerTool } as unknown as ExtensionAPI)).rejects.toThrow(
    path,
  );
  expect(on).not.toHaveBeenCalled();
  expect(registerTool).not.toHaveBeenCalled();
});
