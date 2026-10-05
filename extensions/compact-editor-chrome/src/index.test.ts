import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import compactEditorChrome from "./index.ts";

const directory = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "chrome-index-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});
// Rendering tests must never launch Git against the working checkout.
vi.mock("./git.ts", () => ({
  GitStatusPoller: class {
    snapshot() {
      return null;
    }
    refresh() {}
    invalidate() {}
    dispose() {}
  },
}));
const path = join(directory, "extensions", "eleith.json");
mkdirSync(join(directory, "extensions"));
beforeEach(() => rmSync(path, { force: true }));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function load(mode: ExtensionContext["mode"] = "tui") {
  type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
  type Listener = (event: { type: string }, ctx: ExtensionCommandContext) => void;
  const listeners = new Map<string, Listener[]>();
  const pi = {
    on: vi.fn((name: string, listener: Listener) => {
      const handlers = listeners.get(name) ?? [];
      handlers.push(listener);
      listeners.set(name, handlers);
      return () => {};
    }),
    getCommands: vi.fn(() => []),
    registerCommand: vi.fn((_name: string, _command: Command) => {}),
  };
  const statuses = new Map([["nono", "sandbox active"]]);
  const theme = {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  } as unknown as Theme;
  const tui = { requestRender: vi.fn() } as unknown as TUI;
  const footerData = {
    getExtensionStatuses: () => statuses,
    getGitBranch: () => "main",
    getAvailableProviderCount: () => 1,
    onBranchChange: () => vi.fn(),
  };
  const notify = vi.fn();
  const setFooter = vi.fn((factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0]) => {
    if (factory) factory(tui, theme, footerData);
  });
  const ctx = {
    mode,
    cwd: "/work/project",
    ui: { notify, setFooter, setWidget: vi.fn(), setWorkingVisible: vi.fn() },
  } as unknown as ExtensionCommandContext;
  await compactEditorChrome(pi as unknown as ExtensionAPI);
  return {
    pi,
    ctx,
    notify,
    setFooter,
    emit(name: string) {
      for (const handler of listeners.get(name) ?? []) handler({ type: name }, ctx);
    },
    command() {
      const command = pi.registerCommand.mock.calls[0]?.[1];
      if (!command) throw new Error("Command has not been registered");
      return command;
    },
  };
}

it("registers the configured native command once with action completion", async () => {
  writeFileSync(path, '{"commandPrefix":"personal"}');
  const chrome = await load();
  expect(chrome.pi.getCommands).not.toHaveBeenCalled();
  chrome.emit("session_start");
  chrome.emit("session_start");
  expect(chrome.pi.registerCommand).toHaveBeenCalledTimes(1);
  expect(chrome.pi.registerCommand.mock.calls[0]?.[0]).toBe("personal:compact-editor-chrome");
  expect(await chrome.command().getArgumentCompletions?.("h")).toEqual([
    { value: "hide", label: "hide" },
  ]);
  await chrome.command().handler("show hide", chrome.ctx);
  expect(chrome.notify).toHaveBeenLastCalledWith(
    "Usage: /personal:compact-editor-chrome [show|hide|toggle]",
    "warning",
  );
  chrome.emit("session_shutdown");
});

it.each(["rpc", "json", "print"] as const)(
  "keeps %s mode free of footer/widget work",
  async (mode) => {
    const chrome = await load(mode);
    chrome.emit("session_start");
    await chrome.command().handler("toggle", chrome.ctx);
    await chrome.command().handler("show", chrome.ctx);
    chrome.emit("session_shutdown");
    expect(chrome.setFooter).not.toHaveBeenCalled();
    expect(chrome.ctx.ui.setWidget).not.toHaveBeenCalled();
  },
);

it("fails invalid config before any capability is registered", async () => {
  writeFileSync(path, '{"commandPrefix":"Invalid Prefix"}');
  const on = vi.fn(),
    registerCommand = vi.fn();
  await expect(
    compactEditorChrome({ on, registerCommand } as unknown as ExtensionAPI),
  ).rejects.toThrow(path);
  expect(on).not.toHaveBeenCalled();
  expect(registerCommand).not.toHaveBeenCalled();
});
