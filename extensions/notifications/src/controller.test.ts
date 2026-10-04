import type { AgentActivityOutcome, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopNotifier } from "./controller.ts";
import type { NotificationTransport } from "./transports.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

function setup(mode: ExtensionContext["mode"] = "tui") {
  const transport = {
    paneTitle: vi.fn<NotificationTransport["paneTitle"]>().mockResolvedValue(undefined),
    deliver: vi.fn<NotificationTransport["deliver"]>().mockResolvedValue("notify-send"),
  };
  const notify = vi.fn();
  const ctx = {
    mode,
    cwd: "/work/project",
    sessionManager: { getSessionName: () => "session" },
    ui: { notify },
  } as unknown as ExtensionContext;
  return { controller: new DesktopNotifier(transport), transport, ctx, notify };
}

async function finish(duration: number, outcome: AgentActivityOutcome = "completed") {
  const fixture = setup();
  fixture.controller.startRun();
  vi.advanceTimersByTime(duration);
  fixture.controller.captureOutcome(outcome);
  await fixture.controller.settleRun(fixture.ctx);
  return fixture;
}

describe("notification timing", () => {
  it.each([14_999, 15_000, 15_001])("uses the 15-second threshold at %d ms", async (duration) => {
    const { transport } = await finish(duration);
    expect(transport.deliver).toHaveBeenCalledTimes(duration >= 15_000 ? 1 : 0);
  });

  it.each(["aborted", "error"] as const)("delivers short %s outcomes", async (outcome) => {
    const { transport } = await finish(100, outcome);
    expect(transport.deliver).toHaveBeenCalledTimes(1);
    expect(transport.deliver.mock.calls[0]?.[0].body).toContain(
      outcome === "aborted" ? "Run stopped" : "error",
    );
  });

  it("counts continuations as one run and uses only the final outcome", async () => {
    const { controller, transport, ctx } = setup();
    controller.startRun();
    vi.advanceTimersByTime(8000);
    controller.captureOutcome("error");
    expect(transport.deliver).not.toHaveBeenCalled();
    controller.startRun();
    vi.advanceTimersByTime(8000);
    controller.captureOutcome("completed");
    await controller.settleRun(ctx);
    expect(transport.deliver.mock.calls[0]?.[0]).toEqual({
      title: "π · session - project",
      body: "Ready for input · completed in 16s",
    });
    await controller.settleRun(ctx);
    expect(transport.deliver).toHaveBeenCalledTimes(1);
  });

  it("does not notify for a settlement without a run", async () => {
    const { controller, transport, ctx } = setup();
    controller.captureOutcome("error");
    await controller.settleRun(ctx);
    expect(transport.paneTitle).not.toHaveBeenCalled();
  });

  it("honors runtime toggles while allowing a manual test when disabled", async () => {
    const { controller, transport, ctx } = setup();
    controller.toggle();
    expect(controller.isEnabled()).toBe(false);
    controller.startRun();
    vi.advanceTimersByTime(20_000);
    controller.captureOutcome("completed");
    await controller.settleRun(ctx);
    expect(transport.deliver).not.toHaveBeenCalled();
    expect(await controller.test(ctx)).toBe("notify-send");
    expect(controller.isEnabled()).toBe(false);
    controller.setEnabled(true);
    expect(controller.isEnabled()).toBe(true);
  });

  it.each(["rpc", "json", "print"] as const)(
    "does no external delivery in %s mode",
    async (mode) => {
      const { controller, transport, ctx, notify } = setup(mode);
      controller.startRun();
      vi.advanceTimersByTime(20_000);
      controller.captureOutcome("error");
      await controller.settleRun(ctx);
      expect(await controller.test(ctx)).toBeUndefined();
      expect(transport.paneTitle).not.toHaveBeenCalled();
      expect(transport.deliver).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(
        "Desktop notification test requires interactive Pi",
        "warning",
      );
    },
  );
});

describe("notification cancellation", () => {
  it.each(["shutdown", "off", "new run"] as const)(
    "discards late pane results after %s",
    async (action) => {
      const { controller, transport, ctx } = setup();
      let complete!: (title: string) => void;
      transport.paneTitle.mockReturnValue(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const pending = controller.test(ctx);
      const signal = transport.paneTitle.mock.calls[0]?.[0];
      if (action === "shutdown") controller.dispose();
      else if (action === "off") controller.setEnabled(false);
      else controller.startRun();
      expect(signal?.aborted).toBe(true);
      complete("old pane");
      expect(await pending).toBeUndefined();
      expect(transport.deliver).not.toHaveBeenCalled();
    },
  );

  it("aborts active delivery and suppresses stale test feedback", async () => {
    const { controller, transport, ctx } = setup();
    let complete!: (delivery: "notify-send") => void;
    transport.deliver.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const pending = controller.test(ctx);
    await Promise.resolve();
    expect(transport.deliver).toHaveBeenCalledTimes(1);
    const signal = transport.deliver.mock.calls[0]?.[1];
    controller.dispose();
    controller.dispose();
    expect(signal?.aborted).toBe(true);
    complete("notify-send");
    expect(await pending).toBeUndefined();
    expect(await controller.test(ctx)).toBeUndefined();
  });

  it("older requests cannot clear a newer pending request", async () => {
    const { controller, transport, ctx } = setup();
    const completions: Array<(value: string) => void> = [];
    transport.paneTitle.mockImplementation(
      () => new Promise((resolve) => completions.push(resolve)),
    );
    const first = controller.test(ctx);
    const second = controller.test(ctx);
    expect(transport.paneTitle.mock.calls[0]?.[0].aborted).toBe(true);
    completions[0]?.("first");
    await first;
    controller.dispose();
    expect(transport.paneTitle.mock.calls[1]?.[0].aborted).toBe(true);
    completions[1]?.("second");
    await second;
    expect(transport.deliver).not.toHaveBeenCalled();
  });
});
