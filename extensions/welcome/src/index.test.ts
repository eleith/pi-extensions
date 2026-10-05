import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import welcome from "./index.ts";
import { ENTRY_TYPE } from "./types.ts";

const { directory, collect } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "welcome-index-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return {
    directory,
    collect: vi.fn(async () => ({
      directory: "/work/project",
      session: "",
      model: "no model selected",
      context: "0 found",
      skills: "0 found",
      prompts: "0 found",
      tools: "0 active / 0 available",
    })),
  };
});
vi.mock("./data.ts", () => ({ collect }));
const path = join(directory, "extensions", "eleith.json");
mkdirSync(join(directory, "extensions"));
beforeEach(() => {
  rmSync(path, { force: true });
  collect.mockClear();
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function load(mode: ExtensionCommandContext["mode"] = "tui", prefix = "eleith") {
  writeFileSync(path, JSON.stringify({ commandPrefix: prefix }));
  type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
  type Listener = (event: { type: string }, ctx: ExtensionCommandContext) => void | Promise<void>;
  const listeners = new Map<string, Listener[]>();
  const entries: SessionEntry[] = [];
  const notify = vi.fn();
  const pi = {
    on: vi.fn((name: string, listener: Listener) => {
      const handlers = listeners.get(name) ?? [];
      handlers.push(listener);
      listeners.set(name, handlers);
      return () => {};
    }),
    getCommands: vi.fn(() => []),
    registerCommand: vi.fn((_name: string, _command: Command) => {}),
    registerEntryRenderer: vi.fn(),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({
        type: "custom",
        id: `entry-${entries.length}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: "2026-01-01T00:00:00Z",
        customType,
        data,
      });
    }),
  };
  const ctx = {
    mode,
    cwd: "/work/project",
    ui: { notify },
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      getSessionId: () => "session",
      getLeafId: () => entries.at(-1)?.id ?? null,
    },
  } as unknown as ExtensionCommandContext;
  await welcome(pi as unknown as ExtensionAPI);
  return {
    pi,
    ctx,
    entries,
    notify,
    async emit(type: string) {
      for (const listener of listeners.get(type) ?? []) await listener({ type }, ctx);
    },
    command() {
      const command = pi.registerCommand.mock.calls[0]?.[1];
      if (!command) throw new Error("Command has not been registered");
      return command;
    },
  };
}

it("registers the saved-entry renderer and prefixed native size command without a sibling API", async () => {
  const tree = await load("tui", "personal");
  expect(tree.pi.registerEntryRenderer).toHaveBeenCalledWith(ENTRY_TYPE, expect.any(Function));
  expect(tree.pi.getCommands).not.toHaveBeenCalled();
  await tree.emit("session_start");
  await tree.emit("session_start");
  expect(tree.pi.registerCommand).toHaveBeenCalledTimes(1);
  expect(tree.pi.registerCommand.mock.calls[0]?.[0]).toBe("personal:welcome");
  expect(await tree.command().getArgumentCompletions?.("s")).toEqual([
    { value: "show", label: "show" },
    { value: "small", label: "small" },
  ]);
  expect(tree.entries).toHaveLength(1);
  await tree.emit("session_shutdown");
});

it("maps no argument, show, and auto to automatic sizing and permits explicit sizes", async () => {
  const tree = await load();
  await tree.emit("session_start");
  for (const action of ["", "show", "auto", " LARGE ", "small", "tiny"])
    await tree.command().handler(action, tree.ctx);
  expect(
    tree.entries.map((entry) =>
      entry.type === "custom" ? (entry.data as { treeSize: string }).treeSize : undefined,
    ),
  ).toEqual(["auto", "auto", "auto", "auto", "large", "small", "tiny"]);
  const before = tree.entries.length;
  await tree.command().handler("small large", tree.ctx);
  expect(tree.entries).toHaveLength(before);
  expect(tree.notify).toHaveBeenLastCalledWith(
    "Usage: /eleith:welcome [show|auto|large|small|tiny]",
    "warning",
  );
  await tree.emit("session_shutdown");
});

it.each(["rpc", "json", "print"] as const)(
  "does not append or collect a card in %s mode",
  async (mode) => {
    const tree = await load(mode);
    await tree.emit("session_start");
    await tree.command().handler("show", tree.ctx);
    expect(tree.entries).toEqual([]);
    expect(collect).not.toHaveBeenCalled();
    await tree.emit("session_shutdown");
  },
);

it("cancels a pending manual tree when the active branch changes", async () => {
  const tree = await load();
  await tree.emit("session_start");
  const data = await collect();
  let resolve!: (value: typeof data) => void;
  collect.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const show = tree.command().handler("tiny", tree.ctx);
  await tree.emit("session_tree");
  resolve(data);
  await show;
  expect(tree.entries).toHaveLength(1);
  await tree.emit("session_shutdown");
});

it("fails invalid settings before registering commands, rendering, or lifecycle hooks", async () => {
  writeFileSync(path, '{"commandPrefix":"Invalid Prefix"}');
  const on = vi.fn(),
    registerCommand = vi.fn(),
    registerEntryRenderer = vi.fn();
  await expect(
    welcome({ on, registerCommand, registerEntryRenderer } as unknown as ExtensionAPI),
  ).rejects.toThrow(path);
  expect(on).not.toHaveBeenCalled();
  expect(registerCommand).not.toHaveBeenCalled();
  expect(registerEntryRenderer).not.toHaveBeenCalled();
});
