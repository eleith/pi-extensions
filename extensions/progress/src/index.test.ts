import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import progress from "./index.ts";

const agentDir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "progress-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});
const configPath = join(agentDir, "extensions", "eleith.json");
mkdirSync(join(agentDir, "extensions"));
const START = "\x1b]9;4;1;0\x07";
const ACTIVE = "\x1b]9;4;3\x07";
const CLEAR = "\x1b]9;4;0\x07";

beforeEach(() => {
  rmSync(configPath, { recursive: true, force: true });
  vi.stubEnv("TMUX", "");
  vi.stubEnv("TERM", "xterm-256color");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});

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
    registerCommand: vi.fn((_name: string, _command: Command) => {}),
  };
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const notify = vi.fn();
  const ctx = { mode, cwd: "/work/project", ui: { notify } } as unknown as ExtensionCommandContext;
  await progress(pi as unknown as ExtensionAPI);
  return {
    pi,
    ctx,
    write,
    notify,
    output: () => write.mock.calls.map(([sequence]) => sequence),
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

describe("progress transport and lifecycle", () => {
  it.each([
    { tmux: "", term: "xterm-256color", wrapped: false },
    { tmux: "/tmp/tmux-session", term: "screen-256color", wrapped: true },
    { tmux: "", term: "tmux-256color", wrapped: true },
  ])("uses the correct OSC transport for $tmux / $term", async ({ tmux, term, wrapped }) => {
    vi.stubEnv("TMUX", tmux);
    vi.stubEnv("TERM", term);
    const bar = await load();
    bar.emit("session_start");
    bar.emit("agent_start");
    vi.advanceTimersByTime(1000);
    bar.emit("agent_settled");
    const sequences = [START, ACTIVE, ACTIVE, CLEAR];
    expect(bar.output()).toEqual(
      wrapped
        ? sequences.map((sequence) => `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`)
        : sequences,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps progress across retries/continuations and clears once at final settlement", async () => {
    const bar = await load();
    expect(bar.output()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    bar.emit("session_start");
    bar.emit("agent_start");
    bar.emit("agent_end");
    bar.emit("agent_before_settle");
    bar.emit("agent_start");
    vi.advanceTimersByTime(2000);
    expect(bar.output()).toEqual([START, ACTIVE, ACTIVE, ACTIVE]);
    bar.emit("agent_settled");
    bar.emit("agent_settled");
    bar.emit("session_shutdown");
    expect(bar.output().filter((sequence) => sequence === CLEAR)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("toggles off by default and resumes a working run with on", async () => {
    const bar = await load();
    bar.emit("session_start");
    bar.emit("agent_start");
    await bar.command().handler("", bar.ctx);
    expect(bar.output()).toEqual([START, ACTIVE, CLEAR]);
    expect(vi.getTimerCount()).toBe(0);
    await bar.command().handler(" ON ", bar.ctx);
    await bar.command().handler("on", bar.ctx);
    expect(bar.output()).toEqual([START, ACTIVE, CLEAR, START, ACTIVE]);
    expect(vi.getTimerCount()).toBe(1);
    bar.emit("session_shutdown");
  });

  it("finishes the test at 20 seconds while preserving the disabled state", async () => {
    const bar = await load();
    bar.emit("session_start");
    await bar.command().handler("off", bar.ctx);
    await bar.command().handler("test", bar.ctx);
    vi.advanceTimersByTime(19_999);
    expect(bar.output().at(-1)).toBe(ACTIVE);
    expect(bar.output()).not.toContain(CLEAR);
    vi.advanceTimersByTime(1);
    expect(bar.output().at(-1)).toBe(CLEAR);
    expect(bar.notify).toHaveBeenLastCalledWith("Terminal progress test finished", "info");
    expect(vi.getTimerCount()).toBe(0);
    bar.write.mockClear();
    bar.emit("agent_start");
    vi.advanceTimersByTime(2000);
    expect(bar.output()).toEqual([]);
  });

  it("cancels a test when a real run begins, without the old timeout clearing the run", async () => {
    const bar = await load();
    bar.emit("session_start");
    await bar.command().handler("test", bar.ctx);
    vi.advanceTimersByTime(5000);
    bar.emit("agent_start");
    bar.notify.mockClear();
    vi.advanceTimersByTime(20_000);
    expect(bar.output().at(-1)).toBe(ACTIVE);
    expect(bar.output().filter((sequence) => sequence === CLEAR)).toHaveLength(1);
    expect(bar.notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    bar.emit("agent_settled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a test during a working run without resetting progress", async () => {
    const bar = await load();
    bar.emit("session_start");
    bar.emit("agent_start");
    await bar.command().handler("test", bar.ctx);
    expect(bar.output()).toEqual([START, ACTIVE]);
    expect(bar.notify).toHaveBeenCalledWith(
      expect.stringContaining("Wait for the current agent run"),
      "warning",
    );
    expect(vi.getTimerCount()).toBe(1);
    bar.emit("session_shutdown");
  });

  it.each(["run", "test"])(
    "cancels all timers and clears once on shutdown during a %s",
    async (kind) => {
      const bar = await load();
      bar.emit("session_start");
      if (kind === "run") bar.emit("agent_start");
      else await bar.command().handler("test", bar.ctx);
      bar.emit("session_shutdown");
      bar.emit("session_shutdown");
      expect(bar.output().filter((sequence) => sequence === CLEAR)).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      bar.write.mockClear();
      bar.notify.mockClear();
      vi.advanceTimersByTime(30_000);
      expect(bar.output()).toEqual([]);
      expect(bar.notify).not.toHaveBeenCalled();
    },
  );

  it("tolerates terminal write failures during start, keepalive, and cleanup", async () => {
    const bar = await load();
    bar.write.mockImplementation(() => {
      throw new Error("Terminal closed");
    });
    bar.emit("session_start");
    expect(() => bar.emit("agent_start")).not.toThrow();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(() => bar.emit("session_shutdown")).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["rpc", "json", "print"] as const)("does no terminal work in %s mode", async (mode) => {
    const bar = await load(mode);
    bar.emit("session_start");
    bar.emit("agent_start");
    for (const action of ["off", "on", "toggle", "test"])
      await bar.command().handler(action, bar.ctx);
    bar.emit("agent_settled");
    bar.emit("session_shutdown");
    expect(bar.output()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(bar.notify).toHaveBeenLastCalledWith(
      "Terminal progress test requires interactive Pi",
      "warning",
    );
  });
});

describe("progress command and configuration", () => {
  it("registers once after binding, with native completions", async () => {
    const bar = await load();
    expect(bar.pi.getCommands).not.toHaveBeenCalled();
    expect(bar.pi.registerCommand).not.toHaveBeenCalled();
    bar.emit("session_start");
    bar.emit("session_start");
    expect(bar.pi.registerCommand).toHaveBeenCalledTimes(1);
    expect(bar.pi.registerCommand.mock.calls[0]?.[0]).toBe("eleith:progress");
    expect(await bar.command().getArgumentCompletions?.(" T")).toEqual([
      { value: "test", label: "test" },
      { value: "toggle", label: "toggle" },
    ]);
    expect(await bar.command().getArgumentCompletions?.("on off")).toBeNull();
  });

  it("uses a custom prefix and rejects extra arguments with matching usage", async () => {
    writeFileSync(configPath, '{"commandPrefix":"personal"}');
    const bar = await load();
    bar.emit("session_start");
    expect(bar.pi.registerCommand.mock.calls[0]?.[0]).toBe("personal:progress");
    await bar.command().handler("off on", bar.ctx);
    expect(bar.notify).toHaveBeenLastCalledWith(
      "Usage: /personal:progress [on|off|test|toggle]",
      "warning",
    );
    bar.emit("agent_start");
    expect(bar.output()).toEqual([START, ACTIVE]);
    bar.emit("session_shutdown");
  });

  it.each(["eleith:progress", "eleith:progress:1"])(
    "keeps progress behavior when %s already exists",
    async (name) => {
      const bar = await load("tui", [{ name }]);
      bar.emit("session_start");
      expect(bar.pi.registerCommand).not.toHaveBeenCalled();
      expect(bar.notify).toHaveBeenCalledWith(
        expect.stringContaining(`/${name} already exists`),
        "warning",
      );
      bar.emit("agent_start");
      expect(bar.output()).toEqual([START, ACTIVE]);
      bar.emit("session_shutdown");
    },
  );

  it("fails invalid config before registering progress behavior or commands", async () => {
    writeFileSync(configPath, '{"commandPrefix":"Invalid Prefix"}');
    const on = vi.fn();
    const registerCommand = vi.fn();
    await expect(progress({ on, registerCommand } as unknown as ExtensionAPI)).rejects.toThrow(
      configPath,
    );
    expect(on).not.toHaveBeenCalled();
    expect(registerCommand).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
