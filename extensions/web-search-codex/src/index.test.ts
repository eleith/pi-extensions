import { expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import webSearchCodex from "./index.ts";
import { asRecord } from "./sources.ts";

vi.mock("@eleith/pi-internal/config", () => ({
  getSettings: vi.fn(async () => ({ commandPrefix: "personal" })),
}));

async function setup(conflicts: { name: string }[] = []) {
  type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
  type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
  const handlers = new Map<string, Handler[]>();
  const active = ["read", "web_search_codex"];
  const api = {
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    }),
    registerTool: vi.fn((_tool: ToolDefinition) => {}),
    registerCommand: vi.fn((_name: string, _command: Command) => {}),
    getCommands: vi.fn(() => conflicts),
    getActiveTools: vi.fn(() => [...active]),
    setActiveTools: vi.fn((names: string[]) => active.splice(0, active.length, ...names)),
    sendUserMessage: vi.fn(),
  };
  const notify = vi.fn();
  const ctx = {
    ui: { notify },
    model: { provider: "openai-codex", api: "openai-codex-responses" },
    isIdle: () => true,
  } as unknown as ExtensionCommandContext;
  await webSearchCodex(api as unknown as ExtensionAPI);
  const emit = async (type: string) => {
    for (const handler of handlers.get(type) ?? []) await handler({}, ctx);
  };
  await emit("session_start");
  return {
    api,
    ctx,
    notify,
    emit,
    active,
    command: api.registerCommand.mock.calls[0]?.[1],
    tool: api.registerTool.mock.calls[0]?.[0],
  };
}

it("registers only the named search tool with frames, annotations, and a minimal schema", async () => {
  const fixture = await setup();
  expect(fixture.api.registerTool).toHaveBeenCalledOnce();
  expect(fixture.tool).toMatchObject({
    name: "web_search_codex",
    renderShell: "self",
    annotations: { readOnlyHint: true, openWorldHint: true },
  });
  expect(fixture.tool?.parameters).toMatchObject({
    properties: { query: { type: "string", maxLength: 4000 } },
    required: ["query"],
    additionalProperties: false,
  });
  expect(Object.keys(asRecord(asRecord(fixture.tool?.parameters)?.properties) ?? {})).toEqual([
    "query",
  ]);
});

it("uses the shared prefixed command, completions, default toggle, and usage handling", async () => {
  const fixture = await setup();
  await fixture.emit("session_start");
  expect(fixture.api.registerCommand).toHaveBeenCalledOnce();
  expect(fixture.api.registerCommand.mock.calls[0][0]).toBe("personal:web-search-codex");
  expect(fixture.command?.getArgumentCompletions?.("t")).toEqual([
    { value: "test", label: "test" },
    { value: "toggle", label: "toggle" },
  ]);
  await fixture.command?.handler("", fixture.ctx);
  expect(fixture.active).toEqual(["read"]);
  await fixture.command?.handler(" ON ", fixture.ctx);
  await fixture.command?.handler("on", fixture.ctx);
  expect(fixture.active).toEqual(["read", "web_search_codex"]);
  await fixture.command?.handler("off", fixture.ctx);
  expect(fixture.active).toEqual(["read"]);
  await fixture.command?.handler("invalid", fixture.ctx);
  expect(fixture.notify).toHaveBeenLastCalledWith(
    "Usage: /personal:web-search-codex [on|off|test|toggle]",
    "warning",
  );
});

it("disabled execution fails without contacting a provider", async () => {
  const fixture = await setup();
  await fixture.command?.handler("off", fixture.ctx);
  const result = await fixture.tool?.execute(
    "id",
    { query: "news" },
    undefined,
    undefined,
    fixture.ctx as never,
  );
  expect(result?.isError).toBe(true);
});

it("test queues an ordinary live tool run only when enabled, idle, and on Codex", async () => {
  const fixture = await setup();
  await fixture.command?.handler("test", fixture.ctx);
  expect(fixture.api.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("call it with query"),
  );
  fixture.api.sendUserMessage.mockClear();
  await fixture.command?.handler("test", { ...fixture.ctx, isIdle: () => false });
  await fixture.command?.handler("test", { ...fixture.ctx, model: undefined });
  await fixture.command?.handler("off", fixture.ctx);
  await fixture.command?.handler("test", fixture.ctx);
  expect(fixture.api.sendUserMessage).not.toHaveBeenCalled();
});

it("does not overwrite a conflicting command", async () => {
  const fixture = await setup([{ name: "personal:web-search-codex" }]);
  expect(fixture.api.registerCommand).not.toHaveBeenCalled();
  expect(fixture.notify).toHaveBeenCalledWith(
    expect.stringContaining("was not registered"),
    "warning",
  );
});
