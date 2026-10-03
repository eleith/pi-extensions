import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import titleStatus from "./index.ts";
import { readCommandPrefix } from "./config.ts";

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
const configPath = join(agentDir, "eleith-extensions.json");

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
  const listeners = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const pi = {
    on: vi.fn((name: string, listener: (event: unknown, ctx: ExtensionContext) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }),
    getCommands: vi.fn(() => existingCommands),
    getSessionName: vi.fn(() => "chat"),
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
      listeners.get(name)?.({ type: name }, ctx);
    },
    command() {
      const command = pi.registerCommand.mock.calls[0]?.[1];
      if (!command) throw new Error("Command has not been registered");
      return command;
    },
  };
}

describe("title-status configuration", () => {
  it("defaults only for a missing file or key", async () => {
    expect(await readCommandPrefix()).toBe("eleith");
    writeFileSync(configPath, "{}");
    expect(await readCommandPrefix()).toBe("eleith");
  });

  it.each(["eleith", "personal", "personal-2"])("uses the configured prefix %s", async (prefix) => {
    writeFileSync(configPath, JSON.stringify({ commandPrefix: prefix }));
    expect(await readCommandPrefix()).toBe(prefix);
  });

  it.each([
    "{",
    "null",
    "[]",
    '"personal"',
    '{"unknown":true}',
    ...[
      null,
      42,
      "",
      "Personal",
      "/personal",
      "personal:tools",
      "personal tools",
      "personal\n",
      "-personal",
    ].map((commandPrefix) => JSON.stringify({ commandPrefix })),
  ])("rejects invalid config without registering capabilities: %s", async (config) => {
    writeFileSync(configPath, config);
    const on = vi.fn();
    const registerCommand = vi.fn();
    await expect(titleStatus({ on, registerCommand } as unknown as ExtensionAPI)).rejects.toThrow(
      configPath,
    );
    expect(on).not.toHaveBeenCalled();
    expect(registerCommand).not.toHaveBeenCalled();
  });

  it("reports a read error instead of silently using the default", async () => {
    mkdirSync(configPath);
    await expect(readCommandPrefix()).rejects.toThrow(configPath);
  });
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
    expect(vi.getTimerCount()).toBe(0);
  });
});
