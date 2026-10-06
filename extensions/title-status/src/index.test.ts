import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import titleStatus from "./index.ts";

// Set the disposable directory before Pi imports, including its import-time managed-tool lookup.
const agentDir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "title-status-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});
const configPath = join(agentDir, "extensions", "eleith.json");
mkdirSync(join(agentDir, "extensions"));

beforeEach(() => {
  rmSync(configPath, { recursive: true, force: true });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});

// Only the four Pi API methods this extension uses; no shared host simulator.
async function load(
  mode: ExtensionContext["mode"] = "tui",
  existingCommands: { name: string }[] = [],
) {
  type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
  type Listener = (event: unknown, ctx: ExtensionContext) => void;
  const listeners = new Map<string, Listener[]>();
  const pi = {
    on: vi.fn((name: string, listener: Listener) => {
      const handlers = listeners.get(name) ?? [];
      handlers.push(listener);
      listeners.set(name, handlers);
      return () => handlers.splice(handlers.indexOf(listener), 1);
    }),
    getCommands: vi.fn(() => existingCommands),
    getSessionName: vi.fn<ExtensionAPI["getSessionName"]>(() => "chat"),
    registerCommand: vi.fn((_name: string, _command: Command) => {}),
  };
  const setTitle = vi.fn();
  const notify = vi.fn();
  const ctx = {
    mode,
    cwd: "/work/project",
    ui: { setTitle, notify },
  } as unknown as ExtensionCommandContext;
  await titleStatus(pi as unknown as ExtensionAPI);
  return {
    pi,
    ctx,
    setTitle,
    notify,
    emit(name: string) {
      for (const listener of listeners.get(name) ?? []) listener({ type: name }, ctx);
    },
    command() {
      const command = pi.registerCommand.mock.calls[0]?.[1];
      if (!command) throw new Error("Command has not been registered");
      return command;
    },
  };
}

it("fails invalid config before registering title behavior or commands", async () => {
  writeFileSync(configPath, '{"commandPrefix":"Invalid Prefix"}');
  const on = vi.fn();
  const registerCommand = vi.fn();
  await expect(titleStatus({ on, registerCommand } as unknown as ExtensionAPI)).rejects.toThrow(
    configPath,
  );
  expect(on).not.toHaveBeenCalled();
  expect(registerCommand).not.toHaveBeenCalled();
});

describe("title-status command and lifecycle", () => {
  it("registers only after session_start, once, with native action completion", async () => {
    const title = await load();
    expect(title.pi.getCommands).not.toHaveBeenCalled();
    expect(title.pi.registerCommand).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    title.emit("session_start");
    title.emit("session_start");
    expect(title.pi.registerCommand).toHaveBeenCalledTimes(1);
    expect(title.pi.registerCommand.mock.calls[0]?.[0]).toBe("eleith:title-status");
    expect(await title.command().getArgumentCompletions?.(" HI")).toEqual([
      { value: "hide", label: "hide" },
    ]);
    expect(await title.command().getArgumentCompletions?.("hide show")).toBeNull();
  });

  it("defers idle updates and spins every 300 ms until final settlement", async () => {
    const title = await load();
    title.emit("session_start");
    expect(title.setTitle).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
    expect(title.setTitle).toHaveBeenLastCalledWith("π - chat");
    title.emit("agent_start");
    expect(title.setTitle).toHaveBeenLastCalledWith("◰ - chat");
    vi.advanceTimersByTime(300);
    expect(title.setTitle).toHaveBeenLastCalledWith("◳ - chat");
    title.emit("agent_end"); // Retry/continuation is not final settlement.
    vi.advanceTimersByTime(300);
    expect(title.setTitle).toHaveBeenLastCalledWith("◲ - chat");
    title.emit("agent_settled");
    expect(title.setTitle).toHaveBeenLastCalledWith("π - chat");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["chat", "", undefined])(
    "looks up session name %s once across spinner ticks and hide/show",
    async (name) => {
      const title = await load();
      title.pi.getSessionName.mockReturnValue(name);
      title.emit("session_start");
      vi.runOnlyPendingTimers();
      title.emit("agent_start");
      vi.advanceTimersByTime(30_000);
      expect(title.setTitle).toHaveBeenCalledTimes(102);
      expect(title.setTitle).toHaveBeenLastCalledWith(`◰ - ${name || "project"}`);
      await title.command().handler("hide", title.ctx);
      await title.command().handler("show", title.ctx);
      title.emit("agent_settled");
      expect(title.setTitle).toHaveBeenLastCalledWith(`π - ${name || "project"}`);
      expect(title.pi.getSessionName).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("invalidates on rename but waits until the deferred render to look up the name", async () => {
    const title = await load();
    title.emit("session_start");
    vi.runOnlyPendingTimers();
    title.emit("agent_start");
    title.emit("session_info_changed");
    expect(title.pi.getSessionName).toHaveBeenCalledOnce();
    title.pi.getSessionName.mockReturnValue("new\u0007\u001b\nname");
    vi.advanceTimersByTime(0);
    expect(title.setTitle).toHaveBeenLastCalledWith("◰ - new name");
    vi.advanceTimersByTime(300);
    expect(title.setTitle).toHaveBeenLastCalledWith("◳ - new name");
    expect(title.pi.getSessionName).toHaveBeenCalledTimes(2);
    title.pi.getSessionName.mockReturnValue("");
    title.emit("session_info_changed");
    vi.advanceTimersByTime(600);
    expect(title.setTitle).toHaveBeenLastCalledWith("◱ - project");
    expect(title.pi.getSessionName).toHaveBeenCalledTimes(3);
  });

  it("invalidates on session replacement, including when title status is hidden", async () => {
    const title = await load();
    title.emit("session_start");
    vi.runOnlyPendingTimers();
    await title.command().handler("hide", title.ctx);
    title.pi.getSessionName.mockReturnValue("replacement");
    title.emit("session_start");
    expect(title.pi.getSessionName).toHaveBeenCalledOnce();
    await title.command().handler("show", title.ctx);
    expect(title.setTitle).toHaveBeenLastCalledWith("π - replacement");
    expect(title.pi.getSessionName).toHaveBeenCalledTimes(2);
  });

  it("invalidates hidden renames so showing the title uses the latest name", async () => {
    const title = await load();
    title.emit("session_start");
    vi.runOnlyPendingTimers();
    await title.command().handler("hide", title.ctx);
    title.pi.getSessionName.mockReturnValue("renamed while hidden");
    title.emit("session_info_changed");
    expect(title.pi.getSessionName).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await title.command().handler("show", title.ctx);
    expect(title.setTitle).toHaveBeenLastCalledWith("π - renamed while hidden");
    expect(title.pi.getSessionName).toHaveBeenCalledTimes(2);
  });

  it("toggles by default, preserves a working run across hide/show, and rejects extra arguments", async () => {
    const title = await load();
    title.emit("session_start");
    title.emit("agent_start");
    await title.command().handler("", title.ctx);
    expect(title.setTitle).toHaveBeenLastCalledWith("π - chat - project");
    expect(vi.getTimerCount()).toBe(0);
    await title.command().handler(" SHOW ", title.ctx);
    expect(title.setTitle).toHaveBeenLastCalledWith("◰ - chat");
    await title.command().handler("hide show", title.ctx);
    expect(title.notify).toHaveBeenLastCalledWith(
      "Usage: /eleith:title-status [show|hide|toggle]",
      "warning",
    );
    expect(vi.getTimerCount()).toBe(1);
  });

  it("uses renamed commands and advice without changing the config filename", async () => {
    writeFileSync(configPath, '{"commandPrefix":"personal"}');
    const title = await load();
    title.emit("session_start");
    expect(title.pi.registerCommand.mock.calls[0]?.[0]).toBe("personal:title-status");
    await title.command().handler("unknown", title.ctx);
    expect(title.notify).toHaveBeenLastCalledWith(
      "Usage: /personal:title-status [show|hide|toggle]",
      "warning",
    );
  });

  it.each(["eleith:title-status", "eleith:title-status:1"])(
    "keeps title behavior when %s already exists",
    async (name) => {
      const title = await load("tui", [{ name }]);
      title.emit("session_start");
      expect(title.pi.registerCommand).not.toHaveBeenCalled();
      expect(title.notify).toHaveBeenCalledWith(
        expect.stringContaining(`/${name} already exists`),
        "warning",
      );
      vi.runOnlyPendingTimers();
      expect(title.setTitle).toHaveBeenLastCalledWith("π - chat");
    },
  );

  it("sanitizes session labels, falls back to cwd, and cancels pending rename updates on shutdown", async () => {
    const title = await load();
    title.pi.getSessionName.mockReturnValue("work\u0007\u001b\nname");
    title.emit("session_start");
    vi.runOnlyPendingTimers();
    expect(title.setTitle).toHaveBeenLastCalledWith("π - work name");
    title.pi.getSessionName.mockReturnValue("");
    title.emit("session_info_changed");
    vi.runOnlyPendingTimers();
    expect(title.setTitle).toHaveBeenLastCalledWith("π - project");
    title.emit("agent_start");
    title.emit("session_info_changed");
    title.emit("session_shutdown");
    title.emit("session_shutdown");
    expect(vi.getTimerCount()).toBe(0);
    title.setTitle.mockClear();
    vi.advanceTimersByTime(1000);
    expect(title.setTitle).not.toHaveBeenCalled();
  });

  it.each(["rpc", "json", "print"] as const)("does no terminal work in %s mode", async (mode) => {
    const title = await load(mode);
    title.emit("session_start");
    title.emit("agent_start");
    await title.command().handler("toggle", title.ctx);
    await title.command().handler("show", title.ctx);
    title.emit("agent_settled");
    title.emit("session_shutdown");
    expect(title.setTitle).not.toHaveBeenCalled();
    expect(title.pi.getSessionName).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
