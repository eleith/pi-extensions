import { rmSync } from "node:fs";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { BorderedLoader, initTheme } from "@earendil-works/pi-coding-agent";
import { CodexAccountError, type CodexAccountRegistry, type fetchCodexUsage } from "./client.ts";
import { UsageController, type UsageHost } from "./usage-controller.ts";
import { customInteractionUI } from "./custom-interaction.test-helper.ts";

const directory = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "codex-usage-controller-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  return directory;
});
initTheme("dark", false);
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.useRealTimers();
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("renders and animates the native bordered loader, then closes before notifying", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(response.promise);
  const request = f.controller.report(f.ctx);
  await Promise.resolve();
  const modal = f.ctx.modals[0];
  const loader = modal.component!;
  expect(loader).toBeInstanceOf(BorderedLoader);
  const lines = loader.render(60);
  expect(lines[0]).toBe("─".repeat(60));
  expect(lines.at(-1)).toBe("─".repeat(60));
  expect(lines.join("\n")).toContain("Fetching Codex usage…");
  expect(lines.join("\n")).toMatch(/esc.*cancel/i);
  const renderCount = f.ctx.requestRender.mock.calls.length;
  vi.advanceTimersByTime(160);
  expect(f.ctx.requestRender.mock.calls.length).toBeGreaterThan(renderCount);
  expect(loader.render(60)).not.toEqual(lines);
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
  expect(f.fetchUsage).toHaveBeenCalledExactlyOnceWith(
    f.ctx.modelRegistry,
    expect.any(AbortSignal),
  );
  const signal = f.fetchUsage.mock.calls[0][1]!;
  const removeAbort = vi.spyOn(signal, "removeEventListener");
  const removeLoaderAbort = vi.spyOn((loader as BorderedLoader).signal, "removeEventListener");
  const notify = f.ctx.ui.notify;
  notify.mockImplementation(() => {
    expect(modal.closed).toBe(true);
    expect(modal.close).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);
    expire(f.ctx);
  });

  response.resolve({ plan_type: "plus" });
  await request;
  expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Plan: plus"), "info");
  expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(removeLoaderAbort).toHaveBeenCalledWith("abort", expect.any(Function));
  const stoppedCount = f.ctx.requestRender.mock.calls.length;
  vi.advanceTimersByTime(160);
  expect(f.ctx.requestRender).toHaveBeenCalledTimes(stoppedCount);
});

it.each(["success", "error"] as const)(
  "Escape aborts and closes immediately even when fetch ignores abort, ignoring late %s",
  async (outcome) => {
    const f = fixture();
    const response = deferred<unknown>();
    f.fetchUsage.mockReturnValueOnce(response.promise);
    const request = f.controller.report(f.ctx);
    await Promise.resolve();
    const modal = f.ctx.modals[0];
    const signal = f.fetchUsage.mock.calls[0][1]!;
    const loader = modal.component as BorderedLoader;
    const removeAbort = vi.spyOn(signal, "removeEventListener");
    const removeLoaderAbort = vi.spyOn(loader.signal, "removeEventListener");
    loader.handleInput("\u001b");
    expect(loader.signal.aborted).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(modal.closed).toBe(true);
    expect(modal.close).toHaveBeenCalledOnce();
    await request; // No need to settle the uncooperative fetch.
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(removeLoaderAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    const notify = f.ctx.ui.notify;
    expire(f.ctx);
    if (outcome === "error") response.reject(new Error("private late failure"));
    else response.resolve({ plan_type: "late-plan" });
    await response.promise.catch(() => {});
    expect(notify).not.toHaveBeenCalled();
    expect(modal.close).toHaveBeenCalledOnce();
  },
);

it("treats external component disposal as cancellation, not just an animation stop", async () => {
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(response.promise);
  const request = f.controller.report(f.ctx);
  await Promise.resolve();
  const modal = f.ctx.modals[0];
  const loader = modal.component as BorderedLoader;
  loader.dispose();
  expect(loader.signal.aborted).toBe(false); // Native disposal itself does not abort.
  expect(f.fetchUsage.mock.calls[0][1]!.aborted).toBe(true);
  expect(modal.closed).toBe(true);
  await request;
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
  response.resolve({ plan_type: "late" });
  await response.promise;
  expect(modal.close).toHaveBeenCalledOnce();
});

it.each(["cancel", "dispose"] as const)(
  "%s closes only the owned modal with no expired context access or late delivery",
  async (action) => {
    for (const fails of [false, true]) {
      const f = fixture();
      const response = deferred<unknown>();
      f.fetchUsage.mockReturnValueOnce(response.promise);
      const request = f.controller.report(f.ctx);
      await Promise.resolve();
      const modal = f.ctx.modals[0];
      const signal = f.fetchUsage.mock.calls[0][1]!;
      const notify = f.ctx.ui.notify;
      expire(f.ctx);
      f.controller[action]();
      expect(signal.aborted).toBe(true);
      expect(modal.closed).toBe(true);
      expect(modal.close).toHaveBeenCalledOnce();
      f.controller[action]();
      await request;
      if (fails) response.reject(new Error("private late failure"));
      else response.resolve({ plan_type: "late" });
      await response.promise.catch(() => {});
      expect(notify).not.toHaveBeenCalled();
      expect(modal.close).toHaveBeenCalledOnce();
      if (action === "dispose") {
        await f.controller.report(f.ctx);
        expect(f.fetchUsage).toHaveBeenCalledOnce();
      }
    }
  },
);

it("supersedes before adoption and stops the old animation before any manual disposal", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const oldRequest = f.controller.report(f.ctx);
  const oldModal = f.ctx.modals[0];
  const oldSignal = f.fetchUsage.mock.calls[0][1]!;
  const oldNotify = f.ctx.ui.notify;
  expire(f.ctx);
  const fresh = host("tui", f.ctx.surface);
  const newRequest = f.controller.report(fresh);
  expect(oldSignal.aborted).toBe(true);
  expect(oldModal.closed).toBe(true);
  await oldRequest;
  await Promise.resolve();
  const newModal = fresh.modals[1];
  expect(oldModal.adopted).toBe(false);
  expect(newModal.adopted).toBe(true);
  expect(newModal.closed).toBe(false);
  expect(f.ctx.surface.focusedComponent).toBe(newModal.component);
  expect(f.ctx.surface.components).toEqual([f.ctx.surface.mainEditor, newModal.component]);
  const oldRenderCount = oldModal.requestRender.mock.calls.length;
  const newRenderCount = newModal.requestRender.mock.calls.length;
  vi.advanceTimersByTime(320);
  // This must precede manual disposal/fixture cleanup: early done is not adopted by Pi.
  expect(oldModal.requestRender).toHaveBeenCalledTimes(oldRenderCount);
  expect(newModal.requestRender.mock.calls.length).toBeGreaterThan(newRenderCount);
  oldModal.component!.dispose?.();
  (oldModal.component as BorderedLoader).handleInput("\u001b");
  first.reject(new CodexAccountError("http", "Late rate limit", 60_000));
  await first.promise.catch(() => {});
  expect(newModal.closed).toBe(false);
  expect(newModal.close).not.toHaveBeenCalled();
  expect(oldNotify).not.toHaveBeenCalled();
  second.resolve({ plan_type: "new-plan" });
  await newRequest;
  expect(newModal.close).toHaveBeenCalledOnce();
  expect(fresh.ui.notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Plan: new-plan"),
    "info",
  );
  await f.controller.report(fresh);
  expect(f.fetchUsage).toHaveBeenCalledTimes(3); // The stale rate limit did not apply.
});

it.each([
  ["complete", false],
  ["complete", true],
  ["cancel", false],
  ["cancel", true],
] as const)(
  "old usage %s preserves a newer interaction (overlay: %s) on the same UI surface",
  async (action, overlay) => {
    const f = fixture();
    const response = deferred<unknown>();
    f.fetchUsage.mockReturnValueOnce(response.promise);
    const request = f.controller.report(f.ctx);
    await Promise.resolve();
    const usageModal = f.ctx.modals[0];
    const surface = f.ctx.surface;
    expect(f.ctx.ui.custom).toHaveBeenCalledWith(expect.any(Function), { overlay: true });
    expect(surface.focusedComponent).toBe(usageModal.component);
    expect(surface.components).toEqual([surface.mainEditor, usageModal.component]);

    const newerComponent = {
      render: () => ["newer interaction"],
      invalidate() {},
      dispose: vi.fn(),
    };
    const newerRequest = f.ctx.ui.custom<void>(() => newerComponent, { overlay });
    await Promise.resolve();
    const newerModal = f.ctx.modals[1];
    expect(surface.focusedComponent).toBe(newerComponent);
    expect(surface.editorComponent).toBe(overlay ? surface.mainEditor : newerComponent);
    expect(surface.components).toContain(usageModal.component);
    expect(surface.components).toContain(newerComponent);

    if (action === "cancel") f.controller.cancel();
    else response.resolve({ plan_type: "plus" });
    await request;
    expect(usageModal.closed).toBe(true);
    expect(newerModal.closed).toBe(false);
    expect(newerModal.close).not.toHaveBeenCalled();
    expect(newerComponent.dispose).not.toHaveBeenCalled();
    expect(surface.focusedComponent).toBe(newerComponent);
    expect(surface.editorComponent).toBe(overlay ? surface.mainEditor : newerComponent);
    expect(surface.components).toEqual(
      overlay ? [surface.mainEditor, newerComponent] : [newerComponent],
    );
    expect(newerModal.lines).toEqual(["newer interaction"]);

    // The newer interaction still owns its completion and can return focus normally.
    newerModal.close();
    await newerRequest;
    expect(newerComponent.dispose).toHaveBeenCalledOnce();
    expect(surface.focusedComponent).toBe(surface.mainEditor);
    expect(surface.components).toEqual([surface.mainEditor]);
    if (action === "cancel") {
      response.resolve({ plan_type: "late" });
      await response.promise;
      expect(f.ctx.ui.notify).not.toHaveBeenCalled();
    }
  },
);

it("suppresses a report when the session changes without an explicit cancellation", async () => {
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(response.promise);
  const request = f.controller.report(f.ctx);
  f.ctx.sessionManager.getSessionId.mockReturnValue("replacement-session");
  response.resolve({ plan_type: "plus" });
  await request;
  expect(f.ctx.modals[0].closed).toBe(true);
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
  f.controller.cancel();
  expect(f.ctx.modals[0].close).toHaveBeenCalledOnce();
});

it.each([
  [
    "unrecognized response",
    { private_account_data: "do-not-display" },
    undefined,
    "Codex account service returned an unrecognized usage response.",
  ],
  [
    "unexpected error",
    undefined,
    new Error("private failure details"),
    "Could not read Codex account usage.",
  ],
  [
    "account error",
    undefined,
    new CodexAccountError("timeout", "Codex account request timed out."),
    "Codex account request timed out.",
  ],
] as const)("closes before reporting an %s", async (_name, data, error, message) => {
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(response.promise);
  const request = f.controller.report(f.ctx);
  f.ctx.ui.notify.mockImplementation(() => {
    expect(f.ctx.modals[0].closed).toBe(true);
    expect(f.ctx.modals[0].close).toHaveBeenCalledOnce();
  });
  if (error) response.reject(error);
  else response.resolve(data);
  await request;
  expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(message, "warning");
});

it("honors retry-after without polling or opening a loader for a blocked request", async () => {
  const f = fixture();
  f.fetchUsage.mockRejectedValueOnce(
    new CodexAccountError("http", "Codex account service is rate limited.", 60_000),
  );
  await f.controller.report(f.ctx);
  await f.controller.report(f.ctx);
  expect(f.fetchUsage).toHaveBeenCalledOnce();
  expect(f.ctx.ui.custom).toHaveBeenCalledOnce();
  expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(
    "Codex account service is rate limited. Try again in 60s.",
    "warning",
  );
  f.clock.now += 60_000;
  await f.controller.report(f.ctx);
  expect(f.fetchUsage).toHaveBeenCalledTimes(2);
  expect(f.ctx.ui.custom).toHaveBeenCalledTimes(2);
  expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Plan: plus"), "info");
});

it.each(["rpc", "print", "json"] as const)(
  "%s uses only progress notifications, never custom terminal UI",
  async (mode) => {
    for (const fails of [false, true]) {
      const f = fixture(mode);
      if (fails) f.fetchUsage.mockRejectedValueOnce(new Error("private failure"));
      const request = f.controller.report(f.ctx);
      expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith("Fetching Codex usage…", "info");
      await request;
      expect(f.ctx.ui.custom).not.toHaveBeenCalled();
      expect(f.ctx.ui.notify).toHaveBeenCalledTimes(2);
      expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(
        fails ? "Could not read Codex account usage." : expect.stringContaining("Plan: plus"),
        fails ? "warning" : "info",
      );
    }
  },
);

it.each(["rpc", "print"] as const)(
  "%s cancellation settles without waiting, and another request can start",
  async (mode) => {
    const f = fixture(mode);
    const response = deferred<unknown>();
    f.fetchUsage.mockReturnValueOnce(response.promise);
    const oldRequest = f.controller.report(f.ctx);
    f.controller.cancel();
    await oldRequest;
    expect(f.fetchUsage.mock.calls[0][1]!.aborted).toBe(true);
    await f.controller.report(f.ctx);
    expect(f.ctx.ui.notify.mock.calls).toEqual([
      ["Fetching Codex usage…", "info"],
      ["Fetching Codex usage…", "info"],
      [expect.stringContaining("Plan: plus"), "info"],
    ]);
    response.reject(new Error("late failure"));
    await response.promise.catch(() => {});
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(3);
    expect(f.ctx.ui.custom).not.toHaveBeenCalled();
  },
);

it("propagates a final notification failure without touching the invalidated context again", async () => {
  const f = fixture();
  f.ctx.ui.notify.mockImplementation(() => {
    expire(f.ctx);
    throw new Error("UI failure");
  });
  await expect(f.controller.report(f.ctx)).rejects.toThrow("UI failure");
  expect(f.ctx.modals[0].closed).toBe(true);
  f.controller.cancel();
  expect(f.ctx.modals[0].close).toHaveBeenCalledOnce();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function host(mode: UsageHost["mode"] = "tui", surface = customInteractionUI()) {
  cleanup.push(() => surface.dispose());
  return {
    mode,
    modelRegistry: {} as CodexAccountRegistry,
    sessionManager: { getSessionId: vi.fn(() => "session") },
    ui: {
      notify: vi.fn<UsageHost["ui"]["notify"]>(),
      custom: surface.custom,
    },
    modals: surface.modals,
    requestRender: surface.requestRender,
    surface,
  } satisfies UsageHost & {
    modals: typeof surface.modals;
    requestRender: typeof surface.requestRender;
    surface: typeof surface;
  };
}

function fixture(mode: UsageHost["mode"] = "tui") {
  const clock = { now: Date.parse("2026-01-10T12:00:00Z") };
  const fetchUsage = vi.fn<typeof fetchCodexUsage>(async () => ({ plan_type: "plus" }));
  const ctx = host(mode);
  const controller = new UsageController(fetchUsage, () => clock.now);
  cleanup.push(() => controller.dispose());
  return { controller, ctx, fetchUsage, clock };
}

function expire(ctx: UsageHost) {
  for (const key of ["mode", "sessionManager", "modelRegistry", "ui"]) {
    Object.defineProperty(ctx, key, {
      get: () => {
        throw new Error("Expired context");
      },
      configurable: true,
    });
  }
}
