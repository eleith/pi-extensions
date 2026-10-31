import { expect, it, vi } from "vitest";
import { CodexAccountError, type CodexAccountRegistry, type fetchCodexUsage } from "./client.ts";
import { UsageController, type UsageHost } from "./usage-controller.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const clock = { now: Date.parse("2026-01-10T12:00:00Z") };
  const fetchUsage = vi.fn<typeof fetchCodexUsage>(async () => ({ plan_type: "plus" }));
  const ctx = {
    modelRegistry: {} as CodexAccountRegistry,
    sessionManager: { getSessionId: vi.fn(() => "session") },
    ui: { notify: vi.fn() },
  } satisfies UsageHost;
  const controller = new UsageController(fetchUsage, () => clock.now);
  return { controller, ctx, fetchUsage, clock };
}

it("reports the configured Codex account independently of the selected model", async () => {
  const f = fixture();
  await f.controller.report(f.ctx);
  expect(f.fetchUsage).toHaveBeenCalledExactlyOnceWith(
    f.ctx.modelRegistry,
    expect.any(AbortSignal),
  );
  expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("codex account usage · openai-codex"),
    "info",
  );
});

it("supersedes an earlier request and ignores its late reply", async () => {
  const f = fixture();
  const first = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ plan_type: "new-plan" });
  const oldRequest = f.controller.report(f.ctx);
  const oldSignal = f.fetchUsage.mock.calls[0][1]!;
  await f.controller.report(f.ctx);
  expect(oldSignal.aborted).toBe(true);
  first.resolve({ plan_type: "old-plan" });
  await oldRequest;
  expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Plan: new-plan"),
    "info",
  );
});

it.each(["cancel", "dispose"] as const)(
  "%s discards a late reply before accessing expired context",
  async (action) => {
    const f = fixture();
    const response = deferred<unknown>();
    f.fetchUsage.mockReturnValue(response.promise);
    const request = f.controller.report(f.ctx);
    const signal = f.fetchUsage.mock.calls[0][1]!;
    const notify = f.ctx.ui.notify;
    f.controller[action]();
    Object.defineProperty(f.ctx, "sessionManager", {
      get: () => {
        throw new Error("Expired context");
      },
    });
    Object.defineProperty(f.ctx, "ui", {
      get: () => {
        throw new Error("Expired context");
      },
    });
    response.resolve({ plan_type: "plus" });
    await request;
    expect(signal.aborted).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    if (action === "dispose") await f.controller.report(f.ctx);
  },
);

it("disposal suppresses a late error and is idempotent", async () => {
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValue(response.promise);
  const request = f.controller.report(f.ctx);
  f.controller.dispose();
  f.controller.dispose();
  response.reject(new Error("private late failure"));
  await request;
  await f.controller.report(f.ctx);
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
  expect(f.fetchUsage).toHaveBeenCalledOnce();
});

it("does not deliver a reply to a replacement session", async () => {
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValue(response.promise);
  const request = f.controller.report(f.ctx);
  f.ctx.sessionManager.getSessionId.mockReturnValue("different-session");
  response.resolve({ plan_type: "plus" });
  await request;
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
});

it("reports an unrecognized schema without dumping account data", async () => {
  const f = fixture();
  f.fetchUsage.mockResolvedValue({ private_account_data: "do-not-display" });
  await f.controller.report(f.ctx);
  expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
    "Codex account service returned an unrecognized usage response.",
    "warning",
  );
});

it("does not expose unexpected error details", async () => {
  const f = fixture();
  f.fetchUsage.mockRejectedValue(new Error("private failure details"));
  await f.controller.report(f.ctx);
  expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
    "Could not read Codex account usage.",
    "warning",
  );
});

it("honors retry-after without polling or making another request until explicitly asked", async () => {
  const f = fixture();
  f.fetchUsage.mockRejectedValueOnce(
    new CodexAccountError("http", "Codex account service is rate limited.", 60_000),
  );
  await f.controller.report(f.ctx);
  await f.controller.report(f.ctx);
  expect(f.fetchUsage).toHaveBeenCalledOnce();
  expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(
    "Codex account service is rate limited. Try again in 60s.",
    "warning",
  );
  f.clock.now += 60_000;
  expect(f.fetchUsage).toHaveBeenCalledOnce();
  await f.controller.report(f.ctx);
  expect(f.fetchUsage).toHaveBeenCalledTimes(2);
  expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Plan: plus"), "info");
});
