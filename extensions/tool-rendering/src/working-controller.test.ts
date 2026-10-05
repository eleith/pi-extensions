import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkingController } from "./working-controller.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function context(mode: "tui" | "rpc" | "json" | "print" = "tui") {
  let expired = false;
  const setWorkingMessage = vi.fn();
  const ctx = {
    mode,
    get ui() {
      if (expired) throw new Error("Expired context accessed");
      return { setWorkingMessage };
    },
  };
  return {
    ctx,
    setWorkingMessage,
    expire: () => {
      expired = true;
    },
  };
}

it("counts separate model segments while excluding the tool gap", () => {
  const controller = new WorkingController();
  const { ctx, setWorkingMessage } = context();
  controller.beforeAgentStart();
  controller.agentStarted();
  controller.beforeProviderRequest(ctx);
  expect(setWorkingMessage).toHaveBeenLastCalledWith("Working... (0.0s)");
  vi.advanceTimersByTime(1500);
  controller.messageEnded("assistant");
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(9000);
  controller.beforeProviderRequest(ctx);
  expect(setWorkingMessage).toHaveBeenLastCalledWith("Working... (1.5s)");
  vi.advanceTimersByTime(1000);
  expect(setWorkingMessage).toHaveBeenLastCalledWith("Working... (2.5s)");
  controller.settled(ctx);
  expect(setWorkingMessage).toHaveBeenLastCalledWith();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not end a model segment for non-assistant messages", () => {
  const controller = new WorkingController();
  const { ctx, setWorkingMessage } = context();
  controller.beforeProviderRequest(ctx);
  controller.messageEnded("toolResult");
  controller.messageEnded("user");
  vi.advanceTimersByTime(1000);
  expect(setWorkingMessage).toHaveBeenLastCalledWith("Working... (1.0s)");
  expect(vi.getTimerCount()).toBe(1);
  controller.dispose(ctx);
});

it("resets elapsed time when a new run begins", () => {
  const controller = new WorkingController();
  const { ctx, setWorkingMessage } = context();
  controller.beforeProviderRequest(ctx);
  vi.advanceTimersByTime(2000);
  controller.beforeAgentStart();
  controller.beforeProviderRequest(ctx);
  expect(setWorkingMessage).toHaveBeenLastCalledWith("Working... (0.0s)");
  expect(vi.getTimerCount()).toBe(1);
  controller.dispose(ctx);
});

it("a new request invalidates an old callback before it can use an expired context", () => {
  const intervals = vi.spyOn(globalThis, "setInterval");
  const controller = new WorkingController();
  const first = context(),
    next = context();
  controller.beforeProviderRequest(first.ctx);
  const retained = intervals.mock.calls[0][0] as () => void;
  first.expire();
  controller.beforeProviderRequest(next.ctx);
  expect(() => retained()).not.toThrow();
  expect(next.setWorkingMessage).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  controller.dispose(next.ctx);
});

it.each(["sessionStarted", "beforeAgentStart"] as const)(
  "%s cancels ticks and guards retained callbacks",
  (method) => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const controller = new WorkingController();
    const { ctx, expire } = context();
    controller.beforeProviderRequest(ctx);
    const retained = intervals.mock.calls[0][0] as () => void;
    expire();
    controller[method]();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => retained()).not.toThrow();
  },
);

it("shutdown is idempotent and cannot restart timers or revisit the old context", () => {
  const intervals = vi.spyOn(globalThis, "setInterval");
  const controller = new WorkingController();
  const { ctx, expire, setWorkingMessage } = context();
  controller.beforeProviderRequest(ctx);
  const retained = intervals.mock.calls[0][0] as () => void;
  controller.dispose(ctx);
  expire();
  expect(() => {
    retained();
    controller.dispose(ctx);
    controller.agentStarted();
    controller.beforeAgentStart();
    controller.beforeProviderRequest(ctx);
    controller.settled(ctx);
  }).not.toThrow();
  expect(setWorkingMessage).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["rpc", "json", "print"] as const)(
  "does not start UI timers or access UI in %s mode",
  (mode) => {
    const controller = new WorkingController();
    const { ctx, expire, setWorkingMessage } = context(mode);
    expire();
    controller.beforeAgentStart();
    controller.agentStarted();
    controller.beforeProviderRequest(ctx);
    vi.advanceTimersByTime(10000);
    controller.messageEnded("assistant");
    controller.settled(ctx);
    controller.dispose(ctx);
    expect(setWorkingMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
