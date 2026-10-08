import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";
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
  let resolver: Parameters<ExtensionAPI["registerToolRenderer"]>[0] | undefined;
  const api = {
    on: vi.fn((name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {};
    }),
    registerTool: vi.fn(),
    registerToolRenderer: vi.fn((value: Parameters<ExtensionAPI["registerToolRenderer"]>[0]) => {
      resolver = value;
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
    resolve(name: string, downstream?: ToolRenderers) {
      if (!resolver) throw Error("Resolver not registered");
      return resolver(name, () => downstream);
    },
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

function readCall(renderers: ToolRenderers | undefined): string {
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
    durationMs: undefined,
    outputPad: 0,
    invalidate() {},
  };
  const component = renderers?.renderCall?.(args, theme, context);
  if (!component) throw Error("Read renderer missing");
  return component.render(80).map(stripTerminalSequences).join("\n");
}

it("registers one resolver for seven tools and never registers tools", async () => {
  const tree = await load();
  expect(tree.api.registerToolRenderer).toHaveBeenCalledOnce();
  expect(tree.api.registerTool).not.toHaveBeenCalled();
  for (const name of ["bash", "read", "grep", "ls", "find", "write", "edit"]) {
    const renderers = tree.resolve(name);
    expect(renderers?.renderShell).toBe("self");
    expect(Object.keys(renderers!)).toEqual(["renderShell", "renderCall", "renderResult"]);
  }
  const downstream: ToolRenderers = { renderShell: "default" };
  expect(tree.resolve("custom", downstream)).toBe(downstream);
  expect(tree.resolve("custom")).toBeUndefined();
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

it("toggles future rows immediately during a run, without changing existing rows or other factories", async () => {
  const first = await load();
  await first.emit("session_start");
  const firstRow = first.resolve("read");
  const downstream: ToolRenderers = {
    renderShell: "default",
    renderCall: () => new Text("native", 0, 0),
  };
  expect(readCall(firstRow)).toContain("── read");
  await first.emit("agent_start");
  await first.command().handler("hide", first.ctx);
  expect(first.resolve("read", downstream)).toBe(downstream);
  expect(first.resolve("read")).toBeUndefined();
  expect(readCall(firstRow)).toContain("── read");
  expect(first.notify).toHaveBeenLastCalledWith(
    "Tool rendering chrome: hidden (future rows)",
    "info",
  );
  const second = await load();
  await second.emit("session_start");
  expect(readCall(second.resolve("read"))).toContain("── read");
  await first.command().handler(" SHOW ", first.ctx);
  expect(readCall(first.resolve("read"))).toContain("── read");
  expect(readCall(downstream).trimEnd()).toBe("native");
  await first.command().handler("", first.ctx);
  expect(first.resolve("read")).toBeUndefined();
  await first.command().handler("toggle", first.ctx);
  expect(readCall(first.resolve("read"))).toContain("── read");
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
    registerToolRenderer = vi.fn();
  await expect(
    toolRendering({ on, registerToolRenderer } as unknown as ExtensionAPI),
  ).rejects.toThrow(path);
  expect(on).not.toHaveBeenCalled();
  expect(registerToolRenderer).not.toHaveBeenCalled();
});
