import { rmSync } from "node:fs";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { CodexAccountError, type CodexAccountRegistry, type fetchCodexUsage } from "./client.ts";
import { UsageController, type UsageHost } from "./usage-controller.ts";
import { InspectorController } from "./inspector.ts";
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

it("keeps one inspector open from animated loading to result until confirmation", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(response.promise);
  let settled = false;
  const request = f.controller.report(f.ctx).then(() => {
    settled = true;
  });
  await flush();
  const modal = f.ctx.modals[0];
  const component = modal.component!;
  expect(modal.lines.join("\n")).toContain("Codex · Usage");
  expect(modal.lines.join("\n")).toContain("Fetching Codex usage…");
  expect(modal.lines.join("\n")).toMatch(/esc.*cancel/i);
  const renderCount = modal.requestRender.mock.calls.length;
  const loadingLines = [...modal.lines];
  vi.advanceTimersByTime(160);
  expect(modal.requestRender.mock.calls.length).toBeGreaterThan(renderCount);
  expect(modal.lines).not.toEqual(loadingLines);
  expect(f.fetchUsage).toHaveBeenCalledExactlyOnceWith(
    f.ctx.modelRegistry,
    expect.any(AbortSignal),
  );
  response.resolve({ plan_type: "plus" });
  await flush();
  expect(modal.component).toBe(component);
  expect(modal.lines.join("\n")).toContain("Plan: plus");
  expect(modal.lines.join("\n")).not.toContain("Fetching Codex usage");
  expect(modal.closed).toBe(false);
  expect(settled).toBe(false);
  expect(f.ctx.ui.custom).toHaveBeenCalledOnce();
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
  const readyRenderCount = modal.requestRender.mock.calls.length;
  vi.advanceTimersByTime(320);
  expect(modal.requestRender).toHaveBeenCalledTimes(readyRenderCount);
  component.handleInput!("\r");
  await request;
  expect(settled).toBe(true);
  expect(modal.close).toHaveBeenCalledOnce();
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
});

it.each(["success", "error"] as const)(
  "Escape aborts and closes immediately even when fetch ignores abort, ignoring late %s",
  async (outcome) => {
    const f = fixture();
    const response = deferred<unknown>();
    f.fetchUsage.mockReturnValueOnce(response.promise);
    const request = f.controller.report(f.ctx);
    await flush();
    const modal = f.ctx.modals[0];
    const signal = f.fetchUsage.mock.calls[0][1]!;
    modal.component!.handleInput!("\u001b");
    expect(signal.aborted).toBe(true);
    expect(modal.closed).toBe(true);
    await request;
    const notify = f.ctx.ui.notify;
    const renders = modal.requestRender.mock.calls.length;
    expire(f.ctx);
    if (outcome === "error") response.reject(new CodexAccountError("http", "Late limit", 60_000));
    else response.resolve({ plan_type: "late-plan" });
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(modal.requestRender).toHaveBeenCalledTimes(renders);
    expect(modal.close).toHaveBeenCalledOnce();
    const fresh = host();
    const next = f.controller.report(fresh);
    await flush();
    expect(f.fetchUsage).toHaveBeenCalledTimes(2); // A stale rate limit cannot consume retry budget.
    fresh.modals[0].component!.handleInput!("\r");
    await next;
  },
);

it("external component disposal cancels the fetch and settles without waiting", async () => {
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(response.promise);
  const request = f.controller.report(f.ctx);
  await flush();
  const modal = f.ctx.modals[0];
  modal.component!.dispose!();
  expect(f.fetchUsage.mock.calls[0][1]!.aborted).toBe(true);
  expect(modal.closed).toBe(true);
  await request;
  response.resolve({ plan_type: "late" });
  await flush();
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
  expect(modal.close).toHaveBeenCalledOnce();
});

it.each(["cancel", "dispose"] as const)(
  "%s closes only its owned modal without expired context access or late delivery",
  async (action) => {
    for (const fails of [false, true]) {
      const f = fixture();
      const response = deferred<unknown>();
      f.fetchUsage.mockReturnValueOnce(response.promise);
      const request = f.controller.report(f.ctx);
      await flush();
      const modal = f.ctx.modals[0];
      const notify = f.ctx.ui.notify;
      expire(f.ctx);
      if (action === "dispose") f.controller.dispose();
      f.inspector[action]();
      expect(f.fetchUsage.mock.calls[0][1]!.aborted).toBe(true);
      expect(modal.closed).toBe(true);
      f.inspector[action]();
      await request;
      if (fails) response.reject(new Error("private late failure"));
      else response.resolve({ plan_type: "late" });
      await flush();
      expect(notify).not.toHaveBeenCalled();
      expect(modal.close).toHaveBeenCalledOnce();
      if (action === "dispose") {
        await f.controller.report(f.ctx);
        expect(f.fetchUsage).toHaveBeenCalledOnce();
      }
    }
  },
);

it("leaves the shared overview open when only the usage service is disposed", async () => {
  const f = fixture();
  const overview = f.inspector.show(f.ctx, "Overview", { message: "Local state" });
  await flush();
  f.controller.dispose();
  expect(f.ctx.modals[0].closed).toBe(false);
  expire(f.ctx);
  await f.controller.report(f.ctx);
  expect(f.fetchUsage).not.toHaveBeenCalled();
  f.inspector.dispose();
  await overview;
  expect(f.ctx.modals[0].close).toHaveBeenCalledOnce();
});

it("supersedes before adoption and stops the old animation without manual disposal", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const oldRequest = f.controller.report(f.ctx);
  const oldModal = f.ctx.modals[0];
  const oldNotify = f.ctx.ui.notify;
  expire(f.ctx);
  const fresh = host("tui", f.ctx.surface);
  const newRequest = f.controller.report(fresh);
  expect(f.fetchUsage.mock.calls[0][1]!.aborted).toBe(true);
  expect(oldModal.closed).toBe(true);
  await oldRequest;
  await flush();
  const newModal = fresh.modals[1];
  expect(oldModal.adopted).toBe(false);
  expect(newModal.adopted).toBe(true);
  expect(fresh.surface.focusedComponent).toBe(newModal.component);
  expect(fresh.surface.components).toEqual([fresh.surface.mainEditor, newModal.component]);
  const oldRenderCount = oldModal.requestRender.mock.calls.length;
  const newRenderCount = newModal.requestRender.mock.calls.length;
  vi.advanceTimersByTime(320);
  expect(oldModal.requestRender).toHaveBeenCalledTimes(oldRenderCount);
  expect(newModal.requestRender.mock.calls.length).toBeGreaterThan(newRenderCount);
  oldModal.component!.dispose?.();
  oldModal.component!.handleInput!("\u001b");
  first.reject(new CodexAccountError("http", "Late rate limit", 60_000));
  await flush();
  expect(newModal.close).not.toHaveBeenCalled();
  expect(oldNotify).not.toHaveBeenCalled();
  second.resolve({ plan_type: "new-plan" });
  await flush();
  expect(newModal.lines.join("\n")).toContain("Plan: new-plan");
  expect(newModal.closed).toBe(false);
  newModal.component!.handleInput!("\r");
  await newRequest;
  const third = f.controller.report(fresh);
  await flush();
  expect(f.fetchUsage).toHaveBeenCalledTimes(3);
  fresh.modals[2].component!.handleInput!("\u001b");
  await third;
});

it.each([
  ["complete", false],
  ["complete", true],
  ["cancel", false],
  ["cancel", true],
] as const)("old usage %s preserves a newer interaction (overlay: %s)", async (action, overlay) => {
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(response.promise);
  const request = f.controller.report(f.ctx);
  await flush();
  const usageModal = f.ctx.modals[0];
  const surface = f.ctx.surface;
  expect(f.ctx.ui.custom).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ overlay: true }),
  );
  const newerComponent = { render: () => ["newer interaction"], invalidate() {}, dispose: vi.fn() };
  const newerRequest = f.ctx.ui.custom<void>(() => newerComponent, { overlay });
  await flush();
  const newerModal = f.ctx.modals[1];
  expect(surface.focusedComponent).toBe(newerComponent);
  if (action === "cancel") f.inspector.cancel();
  else {
    response.resolve({ plan_type: "plus" });
    await flush();
    expect(usageModal.closed).toBe(false);
    expect(usageModal.lines.join("\n")).toContain("Plan: plus");
    expect(surface.focusedComponent).toBe(newerComponent);
    usageModal.component!.handleInput!("\u001b");
  }
  await request;
  expect(usageModal.closed).toBe(true);
  expect(newerModal.close).not.toHaveBeenCalled();
  expect(newerComponent.dispose).not.toHaveBeenCalled();
  expect(surface.focusedComponent).toBe(newerComponent);
  expect(surface.editorComponent).toBe(overlay ? surface.mainEditor : newerComponent);
  expect(surface.components).toEqual(
    overlay ? [surface.mainEditor, newerComponent] : [newerComponent],
  );
  expect(newerModal.lines).toEqual(["newer interaction"]);
  newerModal.close();
  await newerRequest;
  expect(newerComponent.dispose).toHaveBeenCalledOnce();
  expect(surface.focusedComponent).toBe(surface.mainEditor);
  if (action === "cancel") response.resolve({ plan_type: "late" });
  await flush();
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
});

it("dismisses delivery after session ID changes without explicit cancellation", async () => {
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(response.promise);
  const request = f.controller.report(f.ctx);
  f.ctx.sessionManager.getSessionId.mockReturnValue("replacement-session");
  response.reject(new CodexAccountError("http", "Stale rate limit", 60_000));
  await request;
  expect(f.ctx.modals[0].closed).toBe(true);
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
  const next = f.controller.report(f.ctx);
  await flush();
  expect(f.fetchUsage).toHaveBeenCalledTimes(2);
  f.ctx.modals[1].component!.handleInput!("\r");
  await next;
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
] as const)(
  "keeps an %s in the same modal without notification",
  async (_name, data, error, message) => {
    const f = fixture();
    const response = deferred<unknown>();
    f.fetchUsage.mockReturnValueOnce(response.promise);
    let settled = false;
    const request = f.controller.report(f.ctx).then(() => {
      settled = true;
    });
    await flush();
    if (error) response.reject(error);
    else response.resolve(data);
    await flush();
    const modal = f.ctx.modals[0];
    expect(modal.lines.join("\n")).toContain(message);
    expect(modal.lines.join("\n")).not.toMatch(
      /private failure|do-not-display|Fetching Codex usage/,
    );
    expect(settled).toBe(false);
    expect(modal.closed).toBe(false);
    expect(f.ctx.ui.custom).toHaveBeenCalledOnce();
    expect(f.ctx.ui.notify).not.toHaveBeenCalled();
    modal.component!.handleInput!("\u001b");
    await request;
  },
);

it("keeps retry-after errors in the inspector and opens a static warning without fetch or spinner", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.fetchUsage.mockRejectedValueOnce(
    new CodexAccountError("http", "Codex account service is rate limited.", 60_000),
  );
  const first = f.controller.report(f.ctx);
  await flush();
  expect(f.ctx.modals[0].lines.join("\n")).toContain("Codex account service is rate limited.");
  expect(f.ctx.modals[0].closed).toBe(false);
  // A subsequent report supersedes the still-open rate-limit modal.
  let settled = false;
  const blocked = f.controller.report(f.ctx).then(() => {
    settled = true;
  });
  await first;
  await flush();
  const warning = f.ctx.modals[1];
  expect(f.fetchUsage).toHaveBeenCalledOnce();
  expect(warning.lines.join("\n")).toContain(
    "Codex account service is rate limited. Try again in 60s.",
  );
  expect(warning.renders.some((lines) => lines.join("\n").includes("Fetching Codex usage"))).toBe(
    false,
  );
  const count = warning.requestRender.mock.calls.length;
  vi.advanceTimersByTime(320);
  expect(warning.requestRender).toHaveBeenCalledTimes(count);
  expect(settled).toBe(false);
  warning.component!.handleInput!("\r");
  await blocked;
  f.clock.now += 60_000;
  const next = f.controller.report(f.ctx);
  await flush();
  expect(f.fetchUsage).toHaveBeenCalledTimes(2);
  expect(f.ctx.modals[2].lines.join("\n")).toContain("Plan: plus");
  f.ctx.modals[2].component!.handleInput!("\r");
  await next;
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
});

it("uses the injected configured cancel and confirm actions", async () => {
  const surface = customInteractionUI({
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.cancel": "ctrl+x",
      "tui.select.confirm": "ctrl+y",
    }),
  });
  const f = fixture("tui", surface);
  const request = f.controller.report(f.ctx);
  await flush();
  const modal = f.ctx.modals[0];
  modal.component!.handleInput!("\u001b");
  modal.component!.handleInput!("\r");
  expect(modal.closed).toBe(false);
  modal.component!.handleInput!("\u0019");
  await request;
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(response.promise);
  const pending = f.controller.report(f.ctx);
  await flush();
  f.ctx.modals[1].component!.handleInput!("\u0018");
  await pending;
  expect(f.fetchUsage.mock.calls[1][1]!.aborted).toBe(true);
  response.resolve({ plan_type: "late" });
  await flush();
});

it.each(["rpc", "print", "json"] as const)(
  "%s uses progress and final notifications only",
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
  "%s cancellation settles without waiting and permits another request",
  async (mode) => {
    const f = fixture(mode);
    const response = deferred<unknown>();
    f.fetchUsage.mockReturnValueOnce(response.promise);
    const oldRequest = f.controller.report(f.ctx);
    f.inspector.cancel();
    await oldRequest;
    expect(f.fetchUsage.mock.calls[0][1]!.aborted).toBe(true);
    await f.controller.report(f.ctx);
    expect(f.ctx.ui.notify.mock.calls).toEqual([
      ["Fetching Codex usage…", "info"],
      ["Fetching Codex usage…", "info"],
      [expect.stringContaining("Plan: plus"), "info"],
    ]);
    response.reject(new Error("late failure"));
    await flush();
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(3);
    expect(f.ctx.ui.custom).not.toHaveBeenCalled();
  },
);

it("propagates a non-TUI final notification failure without touching expired context again", async () => {
  const f = fixture("print");
  f.ctx.ui.notify.mockImplementation((message) => {
    if (message === "Fetching Codex usage…") return;
    expire(f.ctx);
    throw new Error("UI failure");
  });
  await expect(f.controller.report(f.ctx)).rejects.toThrow("UI failure");
  f.inspector.cancel();
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

async function flush() {
  // Drain promise-only controller, formatting, and custom-adoption continuations without advancing animations.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function host(mode: UsageHost["mode"] = "tui", surface = customInteractionUI()) {
  cleanup.push(() => surface.dispose());
  return {
    mode,
    modelRegistry: {} as CodexAccountRegistry,
    sessionManager: { getSessionId: vi.fn(() => "session") },
    ui: { notify: vi.fn<UsageHost["ui"]["notify"]>(), custom: surface.custom },
    modals: surface.modals,
    requestRender: surface.requestRender,
    surface,
  } satisfies UsageHost & {
    modals: typeof surface.modals;
    requestRender: typeof surface.requestRender;
    surface: typeof surface;
  };
}

function fixture(mode: UsageHost["mode"] = "tui", surface = customInteractionUI()) {
  const clock = { now: Date.parse("2026-01-10T12:00:00Z") };
  const fetchUsage = vi.fn<typeof fetchCodexUsage>(async () => ({ plan_type: "plus" }));
  const ctx = host(mode, surface);
  const inspector = new InspectorController();
  const controller = new UsageController(inspector, fetchUsage, () => clock.now);
  cleanup.push(() => {
    controller.dispose();
    inspector.dispose();
  });
  return { controller, inspector, ctx, fetchUsage, clock };
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
