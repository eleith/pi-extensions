import { expect, it, vi } from "vitest";
import { CodexAccountError, type CodexAccountRegistry, type fetchCodexUsage } from "./client.ts";
import { UsageController, type UsageHost } from "./usage-controller.ts";

it("shows temporary status immediately, then clears it before reporting the account", async () => {
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockImplementation(() => {
    expect(f.ctx.ui.setStatus).toHaveBeenCalledExactlyOnceWith(
      "eleith-codex-usage",
      "Codex: fetching usage…",
    );
    return response.promise;
  });
  const request = f.controller.report(f.ctx);
  expect(f.ctx.ui.setStatus).toHaveBeenCalledExactlyOnceWith(
    "eleith-codex-usage",
    "Codex: fetching usage…",
  );
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
  expect(f.fetchUsage).toHaveBeenCalledExactlyOnceWith(
    f.ctx.modelRegistry,
    expect.any(AbortSignal),
  );

  f.ctx.ui.notify.mockImplementation(() => {
    expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("eleith-codex-usage", undefined);
    expire(f.ctx);
  });
  const notify = f.ctx.ui.notify;
  const setStatus = f.ctx.ui.setStatus;
  response.resolve({ plan_type: "plus" });
  await request;
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("codex account usage · openai-codex"),
    "info",
  );
  expect(setStatus).toHaveBeenCalledTimes(2);
});

it("supersedes using the new context and never lets a late reply clear the new marker", async () => {
  const f = fixture();
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const oldRequest = f.controller.report(f.ctx);
  const oldSignal = f.fetchUsage.mock.calls[0][1]!;
  const oldUI = f.ctx.ui;
  const fresh = host();
  expire(f.ctx);
  const newRequest = f.controller.report(fresh);
  expect(oldSignal.aborted).toBe(true);
  expect(oldUI.setStatus).toHaveBeenCalledTimes(1);
  expect(fresh.ui.setStatus.mock.calls).toEqual([
    ["eleith-codex-usage", undefined],
    ["eleith-codex-usage", "Codex: fetching usage…"],
  ]);

  first.resolve({ plan_type: "old-plan" });
  await oldRequest;
  expect(oldUI.notify).not.toHaveBeenCalled();
  expect(fresh.ui.setStatus).toHaveBeenCalledTimes(2);
  expect(fresh.ui.notify).not.toHaveBeenCalled();
  second.resolve({ plan_type: "new-plan" });
  await newRequest;
  expect(fresh.ui.setStatus).toHaveBeenLastCalledWith("eleith-codex-usage", undefined);
  expect(fresh.ui.setStatus).toHaveBeenCalledTimes(3);
  expect(fresh.ui.notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Plan: new-plan"),
    "info",
  );
});

it.each(["cancel", "dispose"] as const)(
  "%s clears with fresh context before expiry and ignores late success and error",
  async (action) => {
    for (const fails of [false, true]) {
      const f = fixture();
      const response = deferred<unknown>();
      f.fetchUsage.mockReturnValue(response.promise);
      const request = f.controller.report(f.ctx);
      const signal = f.fetchUsage.mock.calls[0][1]!;
      const oldUI = f.ctx.ui;
      const fresh = host();
      const freshUI = fresh.ui;
      expire(f.ctx);
      f.controller[action](fresh);
      expect(signal.aborted).toBe(true);
      expect(freshUI.setStatus).toHaveBeenCalledExactlyOnceWith("eleith-codex-usage", undefined);
      f.controller[action](fresh);
      expect(freshUI.setStatus).toHaveBeenCalledTimes(1);
      expire(fresh);
      if (fails) response.reject(new Error("private late failure"));
      else response.resolve({ plan_type: "plus" });
      await request;
      expect(oldUI.setStatus).toHaveBeenCalledTimes(1);
      expect(oldUI.notify).not.toHaveBeenCalled();
      expect(freshUI.setStatus).toHaveBeenCalledTimes(1);
      expect(freshUI.notify).not.toHaveBeenCalled();
      if (action === "dispose") {
        await f.controller.report(f.ctx);
        expect(f.fetchUsage).toHaveBeenCalledOnce();
      }
    }
  },
);

it("can start another explicit request after cancellation without waiting for the old request", async () => {
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(response.promise);
  const oldRequest = f.controller.report(f.ctx);
  f.controller.cancel(f.ctx);
  await f.controller.report(f.ctx);
  expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Plan: plus"),
    "info",
  );
  expect(f.ctx.ui.setStatus).toHaveBeenCalledTimes(4);
  response.reject(new CodexAccountError("http", "Late rate limit", 60_000));
  await oldRequest;
  await f.controller.report(f.ctx);
  expect(f.fetchUsage).toHaveBeenCalledTimes(3);
  expect(f.ctx.ui.setStatus).toHaveBeenCalledTimes(6);
});

it("clears a completed request without reporting to a replacement session", async () => {
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValue(response.promise);
  const request = f.controller.report(f.ctx);
  f.ctx.sessionManager.getSessionId.mockReturnValue("different-session");
  response.resolve({ plan_type: "plus" });
  await request;
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
  expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("eleith-codex-usage", undefined);
  expect(f.ctx.ui.setStatus).toHaveBeenCalledTimes(2);
  f.controller.cancel(f.ctx);
  expect(f.ctx.ui.setStatus).toHaveBeenCalledTimes(2);
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
] as const)("clears status before reporting an %s", async (_name, data, error, message) => {
  const f = fixture();
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValue(response.promise);
  const request = f.controller.report(f.ctx);
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
  f.ctx.ui.notify.mockImplementation(() => {
    expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("eleith-codex-usage", undefined);
  });
  if (error) response.reject(error);
  else response.resolve(data);
  await request;
  expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(message, "warning");
  expect(f.ctx.ui.setStatus).toHaveBeenCalledTimes(2);
});

it("honors retry-after without polling or showing a fetching marker for a blocked request", async () => {
  const f = fixture();
  f.fetchUsage.mockRejectedValueOnce(
    new CodexAccountError("http", "Codex account service is rate limited.", 60_000),
  );
  await f.controller.report(f.ctx);
  expect(f.ctx.ui.setStatus).toHaveBeenCalledTimes(2);
  await f.controller.report(f.ctx);
  expect(f.fetchUsage).toHaveBeenCalledOnce();
  expect(f.ctx.ui.setStatus).toHaveBeenCalledTimes(2);
  expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(
    "Codex account service is rate limited. Try again in 60s.",
    "warning",
  );
  f.clock.now += 60_000;
  expect(f.fetchUsage).toHaveBeenCalledOnce();
  await f.controller.report(f.ctx);
  expect(f.fetchUsage).toHaveBeenCalledTimes(2);
  expect(f.ctx.ui.setStatus).toHaveBeenCalledTimes(4);
  expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Plan: plus"), "info");
});

it.each([
  {
    outcome: "success",
    fetch: async () => ({ plan_type: "plus" }),
    message: expect.stringContaining("Plan: plus"),
    level: "info",
  },
  {
    outcome: "failure",
    fetch: async () => {
      throw new Error("private failure");
    },
    message: "Could not read Codex account usage.",
    level: "warning",
  },
] as const)(
  "reports $outcome after plain progress without UI",
  async ({ fetch, message, level }) => {
    const f = fixture(false);
    f.fetchUsage.mockImplementationOnce(fetch);
    const request = f.controller.report(f.ctx);
    expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith("Fetching Codex usage…", "info");
    expect(f.ctx.ui.setStatus).not.toHaveBeenCalled();

    await request;
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(2);
    expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(message, level);
    expect(f.ctx.ui.setStatus).not.toHaveBeenCalled();
  },
);

it.each(["cancel", "dispose"] as const)(
  "%s suppresses completion after plain progress without UI",
  async (action) => {
    const f = fixture(false);
    const response = deferred<unknown>();
    f.fetchUsage.mockReturnValueOnce(response.promise);
    const request = f.controller.report(f.ctx);
    expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith("Fetching Codex usage…", "info");
    expect(f.ctx.ui.setStatus).not.toHaveBeenCalled();

    f.controller[action](f.ctx);
    expect(f.fetchUsage.mock.calls[0][1]!.aborted).toBe(true);
    response.resolve({ plan_type: "old-plan" });
    await request;
    expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith("Fetching Codex usage…", "info");
    expect(f.ctx.ui.setStatus).not.toHaveBeenCalled();
  },
);

it("replaces a request without UI and ignores the old completion", async () => {
  const f = fixture(false);
  const response = deferred<unknown>();
  f.fetchUsage.mockReturnValueOnce(response.promise);
  const oldRequest = f.controller.report(f.ctx);
  const oldSignal = f.fetchUsage.mock.calls[0][1]!;
  expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith("Fetching Codex usage…", "info");

  await f.controller.report(f.ctx);
  expect(oldSignal.aborted).toBe(true);
  expect(f.fetchUsage).toHaveBeenCalledTimes(2);
  expect(f.ctx.ui.notify.mock.calls).toEqual([
    ["Fetching Codex usage…", "info"],
    ["Fetching Codex usage…", "info"],
    [expect.stringContaining("Plan: plus"), "info"],
  ]);

  response.resolve({ plan_type: "old-plan" });
  await oldRequest;
  expect(f.ctx.ui.notify).toHaveBeenCalledTimes(3);
  expect(f.ctx.ui.setStatus).not.toHaveBeenCalled();
});

it("does not hide a final notification failure or try to clear after it invalidates context", async () => {
  const f = fixture();
  const setStatus = f.ctx.ui.setStatus;
  f.ctx.ui.notify.mockImplementation(() => {
    expire(f.ctx);
    throw new Error("UI failure");
  });
  await expect(f.controller.report(f.ctx)).rejects.toThrow("UI failure");
  expect(setStatus).toHaveBeenCalledTimes(2);
  f.controller.cancel(host());
  expect(setStatus).toHaveBeenCalledTimes(2);
});

it("does not swallow a status cleanup failure", async () => {
  const f = fixture();
  f.ctx.ui.setStatus.mockImplementation((_key, text) => {
    if (text === undefined) throw new Error("Status cleanup failure");
  });
  await expect(f.controller.report(f.ctx)).rejects.toThrow("Status cleanup failure");
  expect(f.ctx.ui.notify).not.toHaveBeenCalled();
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

function host(hasUI = true) {
  return {
    hasUI,
    modelRegistry: {} as CodexAccountRegistry,
    sessionManager: { getSessionId: vi.fn(() => "session") },
    ui: {
      notify: vi.fn<UsageHost["ui"]["notify"]>(),
      setStatus: vi.fn<UsageHost["ui"]["setStatus"]>(),
    },
  } satisfies UsageHost;
}

function fixture(hasUI = true) {
  const clock = { now: Date.parse("2026-01-10T12:00:00Z") };
  const fetchUsage = vi.fn<typeof fetchCodexUsage>(async () => ({ plan_type: "plus" }));
  const ctx = host(hasUI);
  const controller = new UsageController(fetchUsage, () => clock.now);
  return { controller, ctx, fetchUsage, clock };
}

function expire(ctx: UsageHost) {
  for (const key of ["hasUI", "sessionManager", "modelRegistry", "ui"]) {
    Object.defineProperty(ctx, key, {
      get: () => {
        throw new Error("Expired context");
      },
      configurable: true,
    });
  }
}
