import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { registerCommand } from "./commands.ts";

function setup(argumentActions?: readonly string[]) {
  type Start = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
  type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
  let start: Start | undefined;
  let command: Command | undefined;
  const handler = vi.fn();
  const notify = vi.fn();
  const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;
  const pi = {
    on: vi.fn((_name: string, callback: Start) => {
      start = callback;
    }),
    getCommands: () => [],
    registerCommand: vi.fn((_name: string, value: Command) => {
      command = value;
    }),
  };
  registerCommand(pi as unknown as ExtensionAPI, {
    name: "personal:fixture",
    description: "Fixture",
    actions: ["on", "off", "test", "toggle"],
    defaultAction: "toggle",
    argumentActions,
    handler,
  });
  if (!start) throw new Error("Missing session_start handler");
  void start({}, ctx);
  if (!command) throw new Error("Missing command");
  return { command, handler, notify, ctx };
}

it("preserves existing single-action handling and rejects tails unless explicitly allowed", async () => {
  const f = setup();
  await f.command.handler("", f.ctx);
  expect(f.handler).toHaveBeenLastCalledWith("toggle", f.ctx);
  await f.command.handler(" ON ", f.ctx);
  expect(f.handler).toHaveBeenLastCalledWith("on", f.ctx);
  f.handler.mockClear();
  for (const args of ["off on", "test https://example.test", "unknown"])
    await f.command.handler(args, f.ctx);
  expect(f.handler).not.toHaveBeenCalled();
  expect(f.notify).toHaveBeenLastCalledWith(
    "Usage: /personal:fixture [on|off|test|toggle]",
    "warning",
  );
});

it("normalizes only the action and preserves trailing URL case/encoding", async () => {
  const f = setup(["test"]);
  const url = "https://Example.test/MyPath?Token=AbC&escaped=%2F";
  await f.command.handler(`  TeSt\t${url}  `, f.ctx);
  expect(f.handler).toHaveBeenLastCalledWith("test", f.ctx, url);
  await f.command.handler("test", f.ctx);
  expect(f.handler).toHaveBeenLastCalledWith("test", f.ctx);
});

it("does not allow arguments for other actions or invent URL completions", async () => {
  const f = setup(["test"]);
  await f.command.handler("toggle extra", f.ctx);
  expect(f.handler).not.toHaveBeenCalled();
  expect(f.command.getArgumentCompletions?.("test https://")).toBe(null);
  expect(f.command.getArgumentCompletions?.("TE")).toEqual([{ value: "test", label: "test" }]);
});
