import type { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BashTiming, bashElapsed } from "./bash-timing.ts";

type Renderer = NonNullable<ReturnType<typeof createBashToolDefinition>["renderResult"]>;
type Context = Parameters<Renderer>[3];
const partial: Parameters<Renderer>[1] = { isPartial: true, expanded: false };
const final = { ...partial, isPartial: false };
function context(overrides: Partial<Context> = {}): Context {
  return {
    args: { command: "echo test" },
    toolCallId: "call",
    cwd: "/unused",
    invalidate: vi.fn(),
    lastComponent: undefined,
    state: { startedAt: undefined, endedAt: undefined, interval: undefined },
    executionStarted: true,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BashTiming", () => {
  it("is inert until an active, non-error execution is rendered", () => {
    const timing = new BashTiming();
    expect(vi.getTimerCount()).toBe(0);
    const waiting = context({ executionStarted: false });
    expect(timing.update(waiting, partial)).toBeUndefined();
    expect(timing.update(context({ isError: true }), partial)).toBe(0);
    expect(timing.update(context(), final)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    timing.dispose();
  });

  it("starts once, invalidates once a second, and paints live elapsed without updates", () => {
    const timing = new BashTiming();
    const ctx = context();
    expect(timing.update(ctx, partial)).toBe(0);
    vi.advanceTimersByTime(1500);
    expect(ctx.invalidate).toHaveBeenCalledTimes(1);
    expect(bashElapsed(ctx.state)).toBe(1500);
    expect(timing.update(ctx, partial)).toBe(1500);
    expect(vi.getTimerCount()).toBe(1);
    expect(ctx.state.startedAt).toBeUndefined();
    expect(ctx.state.interval).toBeUndefined();
    timing.dispose();
  });

  it("freezes on stop before the final renderer and cannot restart on a stale partial", () => {
    const timing = new BashTiming();
    const ctx = context();
    timing.update(ctx, partial);
    vi.advanceTimersByTime(2300);
    timing.stop(ctx.toolCallId);
    timing.stop(ctx.toolCallId);
    vi.advanceTimersByTime(5000);
    expect(timing.update(ctx, partial)).toBe(2300);
    expect(timing.update(ctx, final)).toBe(2300);
    expect(bashElapsed(ctx.state)).toBe(2300);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("settles on final/error (error=%s)", (isError) => {
    const timing = new BashTiming();
    const ctx = context();
    timing.update(ctx, partial);
    vi.advanceTimersByTime(1800);
    ctx.isError = isError;
    expect(timing.update(ctx, isError ? partial : final)).toBe(1800);
    vi.advanceTimersByTime(5000);
    expect(bashElapsed(ctx.state)).toBe(1800);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears all rows, rejects retained callbacks, and starts only fresh rows in the new generation", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const timing = new BashTiming();
    const a = context();
    const b = context({ toolCallId: "other" });
    timing.update(a, partial);
    timing.update(b, partial);
    const oldTick = interval.mock.calls[0]?.[0];
    timing.clear();
    timing.update(a, partial);
    expect(vi.getTimerCount()).toBe(0);
    const fresh = context({ toolCallId: "fresh" });
    timing.update(fresh, partial);
    if (typeof oldTick !== "function") throw new Error("Missing timer callback");
    oldTick();
    expect(a.invalidate).not.toHaveBeenCalled();
    expect(b.invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fresh.invalidate).toHaveBeenCalledTimes(1);
    expect(a.invalidate).not.toHaveBeenCalled();
    expect(b.invalidate).not.toHaveBeenCalled();
    timing.dispose();
    oldTick();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops invalidators on settlement and uses the latest plain invalidator", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const timing = new BashTiming();
    const ctx = context();
    const first = ctx.invalidate;
    timing.update(ctx, partial);
    const tick = interval.mock.calls[0]?.[0];
    const latest = vi.fn();
    timing.update({ ...ctx, invalidate: latest }, partial);
    vi.advanceTimersByTime(1000);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    timing.stop(ctx.toolCallId);
    if (typeof tick !== "function") throw new Error("Missing timer callback");
    tick();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it("is isolated per instance and dispose permanently prevents timer creation", () => {
    const first = new BashTiming();
    const second = new BashTiming();
    const a = context();
    const b = context();
    first.update(a, partial);
    second.update(b, partial);
    first.dispose();
    first.dispose();
    first.update(context(), partial);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(a.invalidate).not.toHaveBeenCalled();
    expect(b.invalidate).toHaveBeenCalledTimes(1);
    second.dispose();
  });

  it("hiding and showing preserves elapsed time and still permits completion while hidden", () => {
    const timing = new BashTiming();
    const ctx = context();
    timing.update(ctx, partial);
    vi.advanceTimersByTime(1000);
    timing.pause();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(timing.update(ctx, partial)).toBe(6000);
    expect(vi.getTimerCount()).toBe(1);
    timing.pause();
    vi.advanceTimersByTime(500);
    timing.stop(ctx.toolCallId);
    expect(timing.update(ctx, final)).toBe(6500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves completed elapsed through lifecycle clears", () => {
    const timing = new BashTiming();
    const ctx = context();
    timing.update(ctx, partial);
    vi.advanceTimersByTime(500);
    timing.update(ctx, final);
    timing.clear();
    vi.advanceTimersByTime(5000);
    expect(timing.update(ctx, final)).toBe(500);
  });
});
