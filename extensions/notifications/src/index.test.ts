import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Delivery } from "./transports.ts";
import type { NotificationMessage } from "./message.ts";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import notifications from "./index.ts";

const { directory, transport } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "notifications-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return {
    directory,
    transport: {
      paneTitle: vi.fn(async (_signal: AbortSignal): Promise<string | undefined> => undefined),
      deliver: vi.fn(
        async (_message: NotificationMessage, _signal: AbortSignal): Promise<Delivery> =>
          "notify-send",
      ),
    },
  };
});
vi.mock("./transports.ts", () => ({
  DesktopTransport: class {
    paneTitle = transport.paneTitle;
    deliver = transport.deliver;
  },
}));
const configPath = join(directory, "extensions", "eleith.json");
mkdirSync(join(directory, "extensions"));
beforeEach(() => {
  rmSync(configPath, { force: true });
  transport.paneTitle.mockClear();
  transport.deliver.mockReset().mockResolvedValue("notify-send");
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function load(mode: ExtensionCommandContext["mode"] = "tui") {
  type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
  type Listener = (
    event: { type: string; outcome?: string; aborted?: boolean },
    ctx: ExtensionCommandContext,
  ) => void | Promise<void>;
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
  const notify = vi.fn();
  const ctx = {
    mode,
    cwd: "/work/project",
    sessionManager: { getSessionName: () => "session" },
    ui: { notify },
  } as unknown as ExtensionCommandContext;
  await notifications(pi as unknown as ExtensionAPI);
  return {
    pi,
    ctx,
    notify,
    async emit(type: string, details: { outcome?: string; aborted?: boolean } = {}) {
      for (const listener of listeners.get(type) ?? []) await listener({ type, ...details }, ctx);
    },
    command() {
      const command = pi.registerCommand.mock.calls[0]?.[1];
      if (!command) throw new Error("Command has not been registered");
      return command;
    },
  };
}

it("registers once after binding and offers native action completion", async () => {
  const notifier = await load();
  expect(notifier.pi.getCommands).not.toHaveBeenCalled();
  await notifier.emit("session_start");
  await notifier.emit("session_start");
  expect(notifier.pi.registerCommand).toHaveBeenCalledTimes(1);
  expect(notifier.pi.registerCommand.mock.calls[0]?.[0]).toBe("eleith:notifications");
  expect(await notifier.command().getArgumentCompletions?.("t")).toEqual([
    { value: "test", label: "test" },
    { value: "toggle", label: "toggle" },
  ]);
});

it("wires final settlement, outcomes, toggles, and test feedback", async () => {
  const notifier = await load();
  await notifier.emit("session_start");
  await notifier.emit("agent_start");
  vi.advanceTimersByTime(16_000);
  await notifier.emit("agent_end");
  expect(transport.deliver).not.toHaveBeenCalled();
  await notifier.emit("agent_before_settle", { outcome: "completed" });
  await notifier.emit("agent_settled");
  expect(transport.deliver).toHaveBeenCalledTimes(1);
  await notifier.command().handler("", notifier.ctx);
  expect(notifier.notify).toHaveBeenLastCalledWith("Eleith notifications: off", "info");
  transport.deliver.mockResolvedValue("none");
  await notifier.command().handler("test", notifier.ctx);
  expect(notifier.notify).toHaveBeenLastCalledWith("Pi notification test: none", "warning");
  await notifier.emit("session_shutdown");
});

it.each([
  { duration: 100, label: "0s" },
  { duration: 16_000, label: "16s" },
])(
  "notifies for an interrupted $duration ms run without a pre-settlement event",
  async ({ duration, label }) => {
    const notifier = await load();
    await notifier.emit("session_start");
    await notifier.emit("agent_start");
    vi.advanceTimersByTime(duration);
    await notifier.emit("agent_settled", { aborted: true });
    expect(transport.deliver).toHaveBeenCalledExactlyOnceWith(
      { title: "π · session - project", body: `Run stopped · ${label}` },
      expect.any(AbortSignal),
    );
    await notifier.emit("agent_settled", { aborted: true });
    expect(transport.deliver).toHaveBeenCalledTimes(1);
    await notifier.emit("session_shutdown");
  },
);

it("prefers the final aborted flag over an earlier completed outcome", async () => {
  const notifier = await load();
  await notifier.emit("session_start");
  await notifier.emit("agent_start");
  await notifier.emit("agent_before_settle", { outcome: "completed" });
  await notifier.emit("agent_settled", { aborted: true });
  expect(transport.deliver.mock.calls[0]?.[0].body).toBe("Run stopped · 0s");
  await notifier.emit("session_shutdown");
});

it("uses the configured prefix and rejects extra arguments", async () => {
  writeFileSync(configPath, '{"commandPrefix":"personal"}');
  const notifier = await load();
  await notifier.emit("session_start");
  expect(notifier.pi.registerCommand.mock.calls[0]?.[0]).toBe("personal:notifications");
  await notifier.command().handler("off on", notifier.ctx);
  expect(notifier.notify).toHaveBeenLastCalledWith(
    "Usage: /personal:notifications [on|off|test|toggle]",
    "warning",
  );
  expect(transport.deliver).not.toHaveBeenCalled();
});

it("does not deliver a command test outside TUI", async () => {
  const notifier = await load("print");
  await notifier.emit("session_start");
  await notifier.command().handler("test", notifier.ctx);
  expect(notifier.notify).toHaveBeenLastCalledWith(
    "Desktop notification test requires interactive Pi",
    "warning",
  );
  expect(transport.paneTitle).not.toHaveBeenCalled();
});

it("fails invalid config before registering capabilities", async () => {
  writeFileSync(configPath, '{"commandPrefix":"Invalid Prefix"}');
  const on = vi.fn(),
    registerCommand = vi.fn();
  await expect(notifications({ on, registerCommand } as unknown as ExtensionAPI)).rejects.toThrow(
    configPath,
  );
  expect(on).not.toHaveBeenCalled();
  expect(registerCommand).not.toHaveBeenCalled();
});
