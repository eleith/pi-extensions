import { rmSync } from "node:fs";
import * as agent from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FramedText } from "./frame.ts";
import { NativeBash } from "./native-bash.ts";

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "native-bash-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});

agent.initTheme("dark", false);

type Tool = ReturnType<typeof agent.createBashToolDefinition>;
type RenderResult = NonNullable<Tool["renderResult"]>;
type Context = Parameters<RenderResult>[3];
type Options = Parameters<RenderResult>[1];
const theme = {
  fg: vi.fn((_color: string, text: string) => text),
  bold: (text: string) => text,
} as unknown as Parameters<RenderResult>[2];
const partial: Options = { expanded: false, isPartial: true };
const final: Options = { expanded: false, isPartial: false };
const adapters: NativeBash[] = [];

function context(overrides: Partial<Context> = {}): Context {
  return {
    args: { command: "echo test" },
    toolCallId: "call",
    cwd: scratch,
    invalidate: vi.fn(),
    lastComponent: undefined,
    state: {} as Context["state"],
    executionStarted: true,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}
function result(text = "output"): Parameters<RenderResult>[0] {
  return { content: [{ type: "text", text }], details: undefined };
}
function fixture() {
  const tool = agent.createBashToolDefinition(scratch);
  if (!tool.renderCall || !tool.renderResult) throw new Error("Missing native bash renderers");
  const adapter = new NativeBash();
  adapters.push(adapter);
  // Observe the real public callbacks, without replacing their implementation or timers.
  const call = vi.fn(tool.renderCall);
  const render = vi.fn(tool.renderResult);
  return { adapter, tool, call, render };
}
function start(f: ReturnType<typeof fixture>, ctx: Context) {
  const call = f.adapter.renderCall(f.call, ctx.args, theme, ctx);
  const output = f.adapter.renderResult(f.render, result(), partial, theme, ctx);
  return { call, output };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  vi.clearAllMocks();
});
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe("NativeBash", () => {
  it("runs a real call/partial/final cycle with isolated opaque row state", () => {
    const f = fixture();
    const otherRenderer = Symbol("other-renderer");
    const hostState = { extensionData: "untouched", [otherRenderer]: { elapsed: 42 } };
    const ctx = context({ state: hostState as unknown as Context["state"] });
    const components = start(f, ctx);
    expect(components.call).toBeInstanceOf(Text);
    expect(components.call.render(80).join("\n")).toContain("$ echo test");
    expect(components.output).toBeInstanceOf(Container);
    expect(components.output.render(80).join("\n")).toContain("Elapsed 0.0s");
    expect(vi.getTimerCount()).toBe(1);
    const nativeContext = f.render.mock.calls[0]![3];
    expect(nativeContext).not.toBe(ctx);
    expect(nativeContext.state).not.toBe(hostState);
    expect(nativeContext.state).toBe(f.call.mock.calls[0]![2].state);
    expect(Object.keys(hostState)).toEqual(["extensionData"]);
    expect(hostState[otherRenderer]).toEqual({ elapsed: 42 });
    expect(Object.getOwnPropertySymbols(hostState)).toHaveLength(2);
    vi.advanceTimersByTime(2300);
    expect(ctx.invalidate).toHaveBeenCalledTimes(2);
    const done = f.adapter.renderResult(f.render, result("done"), final, theme, {
      ...ctx,
      isPartial: false,
      lastComponent: components.output,
    });
    expect(done).toBe(components.output);
    expect(done.render(80).join("\n")).toContain("Took 2.3s");
    expect(vi.getTimerCount()).toBe(0);
    nativeContext.invalidate();
    expect(ctx.invalidate).toHaveBeenCalledTimes(2);
    f.adapter.clear();
    vi.advanceTimersByTime(5000);
    expect(
      f.adapter.renderResult(f.render, result(), final, theme, ctx).render(80).join("\n"),
    ).toContain("Took 2.3s");
    expect(f.render.mock.calls.at(-1)![3].state).toBe(nativeContext.state);
  });

  it.each(["stop", "clear", "dispose"] as const)(
    "%s cleans real native timers without a host final render",
    (action) => {
      const f = fixture();
      const ctx = context();
      start(f, ctx);
      const nativeContext = f.render.mock.calls[0]![3];
      vi.advanceTimersByTime(1500);
      expect(ctx.invalidate).toHaveBeenCalledTimes(1);
      if (action === "stop") f.adapter.stop(ctx.toolCallId);
      else f.adapter[action]();
      expect(vi.getTimerCount()).toBe(0);
      expect(f.render).toHaveBeenCalledTimes(2);
      const cleanup = f.render.mock.calls[1]!;
      expect(cleanup[0]).toBe(f.render.mock.calls[0]![0]);
      expect(cleanup[1]).toEqual({ expanded: false, isPartial: false });
      expect(cleanup[3].state).toBe(nativeContext.state);
      expect(cleanup[3].lastComponent).toBeUndefined();
      expect(cleanup[3].isPartial).toBe(false);
      cleanup[3].invalidate();
      nativeContext.invalidate();
      vi.advanceTimersByTime(5000);
      expect(ctx.invalidate).toHaveBeenCalledTimes(1);
      if (action === "stop") f.adapter.stop(ctx.toolCallId);
      else f.adapter[action]();
      expect(f.render).toHaveBeenCalledTimes(2);
    },
  );

  it("stops one row without disturbing another, and rejects stale partial restarts", () => {
    const f = fixture();
    const a = context();
    const b = context({ toolCallId: "other" });
    start(f, a);
    start(f, b);
    f.adapter.stop("missing");
    vi.advanceTimersByTime(2300);
    f.adapter.stop(a.toolCallId);
    expect(vi.getTimerCount()).toBe(1);
    f.adapter.renderCall(f.call, a.args, theme, a);
    const stale = f.adapter.renderResult(f.render, result(), partial, theme, a);
    expect(stale.render(80).join("\n")).toContain("Took 2.3s");
    expect(f.call.mock.calls.at(-1)![2].executionStarted).toBe(false);
    expect(f.render.mock.calls.at(-1)![1].isPartial).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(a.invalidate).toHaveBeenCalledTimes(2);
    expect(b.invalidate).toHaveBeenCalledTimes(3);
    f.adapter.clear();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears every active row and reenables with fresh state and guarded generations", () => {
    const f = fixture();
    const a = context();
    const b = context({ toolCallId: "other" });
    start(f, a);
    start(f, b);
    const oldA = f.render.mock.calls[0]![3];
    const oldB = f.render.mock.calls[1]![3];
    f.adapter.clear(true);
    expect(vi.getTimerCount()).toBe(0);
    const latest = vi.fn();
    const restarted = { ...a, invalidate: latest };
    start(f, restarted);
    const fresh = f.render.mock.calls.at(-1)![3];
    expect(fresh.state).not.toBe(oldA.state);
    expect(fresh.state).not.toBe(a.state);
    expect(vi.getTimerCount()).toBe(1);
    oldA.invalidate();
    oldB.invalidate();
    expect(a.invalidate).not.toHaveBeenCalled();
    expect(b.invalidate).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(latest).toHaveBeenCalledTimes(1);
    f.adapter.dispose();
    fresh.invalidate();
    oldA.invalidate();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "clear"] as const)(
    "%s revokes suspended rows' restart permission after a mode toggle",
    (action) => {
      const f = fixture();
      const ctx = context();
      start(f, ctx);
      f.adapter.clear(true);
      if (action === "stop") f.adapter.stop(ctx.toolCallId);
      else f.adapter.clear();
      f.adapter.clear();
      start(f, ctx);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.render.mock.calls.at(-1)![1].isPartial).toBe(false);
    },
  );

  it("lifecycle cleanup cannot restart a stale partial row", () => {
    const f = fixture();
    const ctx = context();
    start(f, ctx);
    vi.advanceTimersByTime(1500);
    f.adapter.clear();
    start(f, ctx);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.render.mock.calls.at(-1)![1].isPartial).toBe(false);
    expect(f.render.mock.calls.at(-1)![3].executionStarted).toBe(false);
  });

  it("captures all public context fields and options before the host expires", () => {
    const f = fixture();
    const ctx = context({ expanded: true, showImages: true });
    let expired = false;
    const live = new Proxy(ctx, {
      get(target, key, receiver) {
        if (expired) throw new Error(`Expired host access: ${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
    });
    const liveOptions = new Proxy(
      { ...partial, expanded: true },
      {
        get(target, key, receiver) {
          if (expired) throw new Error(`Expired options access: ${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
      },
    );
    f.adapter.renderCall(f.call, ctx.args, theme, live);
    f.adapter.renderResult(f.render, result(), liveOptions, theme, live);
    const captured = f.render.mock.calls[0]![3];
    for (const key of [
      "args",
      "toolCallId",
      "cwd",
      "executionStarted",
      "argsComplete",
      "isPartial",
      "expanded",
      "showImages",
      "isError",
      "lastComponent",
    ] as const) {
      expect(captured[key]).toBe(ctx[key]);
      expect(Object.getOwnPropertyDescriptor(captured, key)?.get).toBeUndefined();
    }
    expired = true;
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(ctx.invalidate).toHaveBeenCalledTimes(1);
    expect(() => f.adapter.clear()).not.toThrow();
    expect(f.render.mock.calls.at(-1)![1]).toEqual({ expanded: true, isPartial: false });
    captured.invalidate();
    expect(ctx.invalidate).toHaveBeenCalledTimes(1);
  });

  it("uses the latest captured plain invalidator, then drops it on completion", () => {
    const f = fixture();
    const ctx = context();
    start(f, ctx);
    const retained = f.render.mock.calls[0]![3].invalidate;
    const latest = vi.fn();
    f.adapter.renderResult(f.render, result(), partial, theme, { ...ctx, invalidate: latest });
    // The host property is not consulted by the native interval callback.
    ctx.invalidate = () => {
      throw new Error("Live host invalidator accessed");
    };
    vi.advanceTimersByTime(1000);
    expect(latest).toHaveBeenCalledTimes(1);
    f.adapter.stop(ctx.toolCallId);
    retained();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it("never creates timers after dispose, including active-looking historical rows", () => {
    const f = fixture();
    const old = context();
    start(f, old);
    f.adapter.dispose();
    f.adapter.dispose();
    for (const ctx of [old, context({ toolCallId: "history" })]) {
      f.adapter.renderCall(f.call, ctx.args, theme, ctx);
      expect(f.call.mock.calls.at(-1)![2].executionStarted).toBe(false);
      f.adapter.renderResult(f.render, result(), partial, theme, ctx);
      expect(f.render.mock.calls.at(-1)![1].isPartial).toBe(false);
    }
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(old.invalidate).not.toHaveBeenCalled();
  });

  it("does not start native timing before renderCall observes execution starting", () => {
    const f = fixture();
    const waiting = context({ executionStarted: false });
    start(f, waiting);
    expect(vi.getTimerCount()).toBe(0);
    f.adapter.clear();
    expect(f.render).toHaveBeenCalledTimes(1);
    const running = { ...waiting, executionStarted: true };
    // A result alone has no native start time, but still needs lifecycle bookkeeping.
    f.adapter.renderResult(f.render, result(), partial, theme, running);
    expect(vi.getTimerCount()).toBe(0);
    f.adapter.clear(true);
    expect(f.render).toHaveBeenCalledTimes(3);
    start(f, running);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("lets previously unstarted rows begin in the current generation after clear", () => {
    const f = fixture();
    const waiting = context({ executionStarted: false });
    start(f, waiting);
    const old = f.render.mock.calls[0]![3];
    f.adapter.clear();
    start(f, { ...waiting, executionStarted: true });
    old.invalidate();
    expect(waiting.invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(waiting.invalidate).toHaveBeenCalledTimes(1);
  });

  it("cleans partial results after execution was observed by the call renderer", () => {
    const f = fixture();
    const ctx = context();
    f.adapter.renderCall(f.call, ctx.args, theme, ctx);
    f.adapter.renderResult(f.render, result(), partial, theme, {
      ...ctx,
      executionStarted: false,
    });
    expect(vi.getTimerCount()).toBe(1);
    f.adapter.clear();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles call-only rows and absent optional callbacks safely", () => {
    const f = fixture();
    const ctx = context();
    f.adapter.renderCall(f.call, ctx.args, theme, ctx);
    f.adapter.clear(true);
    expect(f.render).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    start(f, ctx);
    expect(vi.getTimerCount()).toBe(1);
    const emptyCall = f.adapter.renderCall(undefined, ctx.args, theme, ctx);
    const emptyResult = f.adapter.renderResult(undefined, result(), partial, theme, ctx);
    expect(emptyCall).toBeInstanceOf(Text);
    expect(emptyResult).toBeInstanceOf(Text);
    expect(() => emptyCall.render(80)).not.toThrow();
    expect(() => emptyResult.render(80)).not.toThrow();
    f.adapter.stop(ctx.toolCallId);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets framed components without preventing native component reuse", () => {
    const f = fixture();
    const framed = new FramedText();
    framed.setPainter(() => "custom frame");
    const ctx = context({ lastComponent: framed });
    const components = start(f, ctx);
    expect(components.call).not.toBe(framed);
    expect(components.output).not.toBe(framed);
    expect(f.call.mock.calls[0]![2].lastComponent).toBeUndefined();
    expect(f.render.mock.calls[0]![3].lastComponent).toBeUndefined();
    expect(
      f.adapter.renderCall(f.call, ctx.args, theme, {
        ...ctx,
        lastComponent: components.call,
      }),
    ).toBe(components.call);
    expect(
      f.adapter.renderResult(f.render, result(), partial, theme, {
        ...ctx,
        lastComponent: components.output,
      }),
    ).toBe(components.output);
  });

  it("keeps instances independent even when tool call ids coincide", () => {
    const first = fixture();
    const second = fixture();
    const a = context();
    const b = context({ state: a.state });
    start(first, a);
    start(second, b);
    const old = first.render.mock.calls[0]![3];
    first.adapter.dispose();
    expect(vi.getTimerCount()).toBe(1);
    old.invalidate();
    vi.advanceTimersByTime(1000);
    expect(a.invalidate).not.toHaveBeenCalled();
    expect(b.invalidate).toHaveBeenCalledTimes(1);
    second.adapter.clear(true);
    start(second, b);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("preserves native tool metadata and result details without calling execution", () => {
    const f = fixture();
    const metadata = { ...f.tool };
    const execute = vi.spyOn(f.tool, "execute");
    const ctx = context();
    f.adapter.renderCall(f.call, ctx.args, theme, ctx);
    const output: Parameters<RenderResult>[0] = {
      content: [{ type: "text", text: "hello" }],
      details: { fullOutputPath: "/tmp/native-output" },
      structuredContent: { output: "structured only", exit_code: 0 },
    };
    const component = f.adapter.renderResult(f.render, output, partial, theme, ctx);
    const text = component.render(100).join("\n");
    expect(text).toContain("hello");
    expect(text).toContain("Full output: /tmp/native-output");
    expect(text).not.toContain("structured only");
    expect(f.render.mock.calls[0]![0]).toBe(output);
    expect(execute).not.toHaveBeenCalled();
    for (const key of Object.keys(metadata) as (keyof Tool)[]) {
      if (key !== "execute") expect(f.tool[key], key).toBe(metadata[key]);
    }
    expect(theme.fg).not.toHaveBeenCalled(); // Pi's native renderer owns its theme singleton.
  });

  it("honors native error cleanup and retains completed state through clear/dispose", () => {
    const f = fixture();
    const ctx = context();
    start(f, ctx);
    vi.advanceTimersByTime(1700);
    const done = f.adapter.renderResult(f.render, result("failure"), partial, theme, {
      ...ctx,
      isError: true,
    });
    const completedState = f.render.mock.calls.at(-1)![3].state;
    expect(done.render(80).join("\n")).toContain("Elapsed 1.7s");
    expect(vi.getTimerCount()).toBe(0);
    f.adapter.clear();
    f.adapter.dispose();
    vi.advanceTimersByTime(5000);
    const historical = f.adapter.renderResult(f.render, result("failure"), final, theme, ctx);
    expect(historical.render(80).join("\n")).toContain("Took 1.7s");
    expect(f.render.mock.calls.at(-1)![3].state).toBe(completedState);
  });
});
