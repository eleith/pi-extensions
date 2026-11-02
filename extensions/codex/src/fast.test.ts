import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ProviderStreamEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAccountError,
  type CodexModelCatalog,
  type fetchCodexModelCatalog,
  type readCodexAuthScope,
} from "./client.ts";
import { FastController, type FastHost } from "./fast.ts";
import { FAST_ENTRY, type FastPreference } from "./fast-state.ts";
import { CONTEXT_ENTRY } from "./state.ts";

const model: Model<Api> = {
  id: "gpt-6-sol",
  name: "Sol",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
};
const otherModel: Model<Api> = { ...model, id: "gpt-6-astra", name: "Astra" };
const catalog: CodexModelCatalog = {
  authScope: "scope-a",
  data: { models: [{ slug: model.id, service_tiers: [{ id: "default" }, { id: "priority" }] }] },
};

describe("commands and ownership", () => {
  it.each(["", "   ", "status", "  STATUS  ", "reset", "enable", "disable", "on extra"])(
    "rejects the unsupported action %j without confirmation, IO or writes",
    async (action) => {
      const fast = createFastControllerFixture();
      fast.ctx.sessionManager.getBranch.mockReturnValue([choice("on")]);
      fast.controller.restore(fast.ctx);
      await fast.controller.handle(action, fast.ctx);
      expect(fast.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
        "Usage: /eleith:codex fast [on|off|toggle]",
        "warning",
      );
      expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
        preference: "on",
        eligibility: "unknown",
        requestPolicy: "suspended",
      });
      expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
      expect(fast.readAuthScope).not.toHaveBeenCalled();
      expect(fast.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
      expect(fast.fetchCatalog).not.toHaveBeenCalled();
      expect(fast.appendEntry).not.toHaveBeenCalled();
    },
  );

  it("does not discover or persist anything when the cost confirmation is declined", async () => {
    const fast = createFastControllerFixture();
    fast.ctx.ui.confirm.mockResolvedValue(false);
    await fast.controller.handle("on", fast.ctx);
    expect(fast.ctx.ui.confirm).toHaveBeenCalledExactlyOnceWith(
      "Enable Codex fast mode?",
      expect.stringContaining("use more of your Codex allowance"),
      { signal: expect.any(AbortSignal) },
    );
    expect(fast.readAuthScope).not.toHaveBeenCalled();
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
    expect(fast.appendEntry).not.toHaveBeenCalled();
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
  });

  it("requires UI to enable, but permits a noninteractive explicit off", async () => {
    const fast = createFastControllerFixture();
    fast.ctx.hasUI = false;
    await fast.controller.handle("on", fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("interactive confirmation"),
      "warning",
    );
    expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(fast.appendEntry).not.toHaveBeenCalled();
    await fast.controller.handle("off", fast.ctx);
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toEqual({
      model: model.id,
      service_tier: "default",
    });
    expect(fast.readAuthScope).not.toHaveBeenCalled();
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
  });

  it("rejects invalid arguments and mutations during a run without prompting or IO", async () => {
    const fast = createFastControllerFixture();
    await fast.controller.handle("on extra", fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Usage: /eleith:codex fast [on|off|toggle]",
      "warning",
    );
    fast.ctx.isIdle.mockReturnValue(false);
    for (const action of ["on", "off", "toggle"]) await fast.controller.handle(action, fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Wait for the current run"),
      "warning",
    );
    expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(fast.readAuthScope).not.toHaveBeenCalled();
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
    expect(fast.appendEntry).not.toHaveBeenCalled();
  });

  it("reports a missing selection rather than confirming or persisting a choice", async () => {
    const fast = createFastControllerFixture();
    fast.ctx.model = undefined;
    await fast.controller.handle("on", fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith("No model selected.", "warning");
    expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(fast.readAuthScope).not.toHaveBeenCalled();
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
    expect(fast.appendEntry).not.toHaveBeenCalled();
  });

  it("persists on only after cost confirmation and matching catalog discovery complete", async () => {
    const fast = createFastControllerFixture();
    const confirmation = deferred<boolean>();
    const response = deferred<CodexModelCatalog>();
    const started = deferred<void>();
    fast.ctx.ui.confirm.mockReturnValue(confirmation.promise);
    fast.fetchCatalog.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const enabling = fast.controller.handle("  ON  ", fast.ctx);
    expect(fast.readAuthScope).not.toHaveBeenCalled();
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
    expect(fast.appendEntry).not.toHaveBeenCalled();
    // A second mutating command must not compete with the confirmation.
    await fast.controller.handle("off", fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Wait for the current run"),
      "warning",
    );
    confirmation.resolve(true);
    await started.promise;
    expect(fast.readAuthScope).toHaveBeenCalledExactlyOnceWith(
      fast.ctx.modelRegistry,
      expect.any(AbortSignal),
    );
    expect(fast.fetchCatalog).toHaveBeenCalledExactlyOnceWith(
      fast.ctx.modelRegistry,
      expect.any(AbortSignal),
    );
    expect(fast.appendEntry).not.toHaveBeenCalled();
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
    response.resolve(catalog);
    await enabling;
    expect(fast.appendEntry).toHaveBeenCalledExactlyOnceWith(FAST_ENTRY, {
      provider: model.provider,
      modelId: model.id,
      mode: "on",
    });
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toEqual({
      model: model.id,
      service_tier: "priority",
    });
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Fast: On (priority requested)"),
      "info",
    );
  });

  it.each([
    { models: [{ slug: otherModel.id, service_tiers: [{ id: "priority" }] }] },
    { models: [{ slug: model.id, service_tiers: [{ id: "default" }] }] },
  ])(
    "does not enable without priority support for the selected catalog model: %j",
    async (data) => {
      const fast = createFastControllerFixture();
      fast.fetchCatalog.mockResolvedValue({ ...catalog, data });
      await fast.controller.handle("on", fast.ctx);
      expect(fast.appendEntry).not.toHaveBeenCalled();
      expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
      expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("Preference unchanged"),
        "warning",
      );
    },
  );

  it("copies a frozen payload for explicit default, preserves fields, then restores a legacy inherit entry", async () => {
    const fast = createFastControllerFixture();
    const input = Object.freeze([{ role: "user", content: "hello" }]);
    const payload = Object.freeze({
      model: model.id,
      input,
      stream: true,
      metadata: { trace: "keep" },
      max_output_tokens: 42,
    });
    await fast.controller.handle("off", fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Fast: Off (standard requested)\n\n/eleith:codex fast on|off|toggle",
      "info",
    );
    const transformed = fast.controller.transform(payload, fast.ctx);
    expect(transformed).toEqual({ ...payload, service_tier: "default" });
    expect(transformed).not.toBe(payload);
    expect(transformed?.input).toBe(input);
    expect(transformed?.metadata).toBe(payload.metadata);
    expect(payload).not.toHaveProperty("service_tier");
    expect(
      fast.controller.transform(Object.freeze({ ...payload, service_tier: "default" }), fast.ctx),
    ).toBeUndefined();
    await fast.controller.handle("off", fast.ctx);
    expect(fast.appendEntry).toHaveBeenCalledOnce();
    fast.ctx.sessionManager.getBranch.mockReturnValue([choice("off"), choice("inherit")]);
    fast.controller.restore(fast.ctx);
    expect(fast.controller.transform(payload, fast.ctx)).toBeUndefined();
    expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
      preference: "inherit",
      requestPolicy: "untouched",
    });
    await fast.controller.prepare(fast.ctx);
    fast.controller.restore(fast.ctx);
    expect(fast.appendEntry).toHaveBeenCalledOnce();
    expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(fast.readAuthScope).not.toHaveBeenCalled();
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
  });

  it("restores a legacy inherit entry after the selection leaves direct scope without writing", async () => {
    const fast = createFastControllerFixture();
    await fast.controller.handle("off", fast.ctx);
    fast.ctx.modelRegistry.isUsingOAuth.mockReturnValue(false);
    fast.ctx.sessionManager.getBranch.mockReturnValue([choice("off"), choice("inherit")]);
    fast.controller.restore(fast.ctx);
    expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
      preference: "inherit",
      requestPolicy: "outside scope",
    });
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
    expect(fast.appendEntry).toHaveBeenCalledOnce();
    expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(fast.readAuthScope).not.toHaveBeenCalled();
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
  });

  it.each(["on", "off"])(
    "preserves an existing non-owned flex tier when %s is selected",
    async (mode) => {
      const fast = createFastControllerFixture();
      const tier = mode === "on" ? "priority" : "default";
      await fast.controller.handle(mode, fast.ctx);
      const payload = Object.freeze({ model: model.id, service_tier: "flex", input: [] });
      expect(fast.controller.transform(payload, fast.ctx)).toBeUndefined();
      expect(payload.service_tier).toBe("flex");
      expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
        conflict: true,
        requestPolicy: tier,
      });
      expect(fast.controller.transform({ model: model.id }, fast.ctx)).toEqual({
        model: model.id,
        service_tier: tier,
      });
      expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
        conflict: false,
        requestPolicy: tier,
      });
    },
  );

  it("toggle confirms only transitions to on and leaves off intact if the next confirmation is declined", async () => {
    const fast = createFastControllerFixture();
    await fast.controller.handle("toggle", fast.ctx);
    expect(fast.ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("priority");
    await fast.controller.handle("toggle", fast.ctx);
    expect(fast.ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("default");
    fast.ctx.ui.confirm.mockResolvedValue(false);
    await fast.controller.handle("toggle", fast.ctx);
    expect(fast.ctx.ui.confirm).toHaveBeenCalledTimes(2);
    expect(fast.appendEntry.mock.calls.map((call) => call[1])).toEqual([
      { provider: model.provider, modelId: model.id, mode: "on" },
      { provider: model.provider, modelId: model.id, mode: "off" },
    ]);
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("default");
    expect(fast.fetchCatalog).toHaveBeenCalledOnce();
  });
});

describe("branch replay and preparation", () => {
  it("replays only the current branch, separates model choices, and ignores context choices", async () => {
    const fast = createFastControllerFixture();
    fast.ctx.sessionManager.getBranch.mockReturnValue([
      choice("off"),
      choice("on"),
      choice("off", otherModel),
      {
        ...choice("off"),
        customType: CONTEXT_ENTRY,
        data: { provider: model.provider, modelId: model.id, extended: true, mode: "off" },
      },
    ]);
    fast.controller.restore(fast.ctx);
    expect(fast.readAuthScope).not.toHaveBeenCalled();
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
    await fast.controller.prepare(fast.ctx);
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("priority");
    fast.ctx.model = otherModel;
    expect(fast.controller.transform({ model: otherModel.id }, fast.ctx)?.service_tier).toBe(
      "default",
    );
    fast.ctx.sessionManager.getBranch.mockReturnValue([choice("on"), choice("inherit")]);
    fast.controller.restore(fast.ctx);
    expect(fast.controller.transform({ model: otherModel.id }, fast.ctx)).toBeUndefined();
    fast.ctx.model = model;
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
    await fast.controller.prepare(fast.ctx);
    expect(fast.readAuthScope).toHaveBeenCalledOnce();
    expect(fast.fetchCatalog).toHaveBeenCalledOnce();
    expect(fast.appendEntry).not.toHaveBeenCalled();
    expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("lets fresh on expire at the TTL without hook IO or erasing the suspended preference", async () => {
    const fast = createFastControllerFixture();
    await fast.controller.handle("on", fast.ctx);
    fast.clock.now += 5 * 60_000 - 1;
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("priority");
    fast.clock.now += 1;
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
    fast.controller.observe(
      stream({ type: "response.completed", response: { service_tier: "default" } }),
      fast.ctx,
    );
    expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
      preference: "on",
      eligibility: "unknown",
      requestPolicy: "suspended",
    });
    expect(fast.readAuthScope).toHaveBeenCalledOnce();
    expect(fast.fetchCatalog).toHaveBeenCalledOnce();
    expect(fast.appendEntry).toHaveBeenCalledOnce();
    await fast.controller.prepare(fast.ctx);
    expect(fast.fetchCatalog).toHaveBeenCalledTimes(2);
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("priority");
    expect(fast.appendEntry).toHaveBeenCalledOnce();
    expect(fast.ctx.ui.confirm).toHaveBeenCalledOnce();
  });

  it("prepares only idle saved-on input, checking auth even when the catalog cache is fresh", async () => {
    const fast = createFastControllerFixture();
    for (const branch of [[], [choice("off")], [choice("inherit")]]) {
      fast.ctx.sessionManager.getBranch.mockReturnValue(branch);
      fast.controller.restore(fast.ctx);
      await fast.controller.prepare(fast.ctx);
    }
    expect(fast.readAuthScope).not.toHaveBeenCalled();
    fast.ctx.sessionManager.getBranch.mockReturnValue([choice("on")]);
    fast.controller.restore(fast.ctx);
    fast.ctx.isIdle.mockReturnValue(false);
    await fast.controller.prepare(fast.ctx);
    expect(fast.readAuthScope).not.toHaveBeenCalled();
    fast.ctx.isIdle.mockReturnValue(true);
    await fast.controller.prepare(fast.ctx);
    await fast.controller.prepare(fast.ctx);
    expect(fast.readAuthScope).toHaveBeenCalledTimes(2);
    expect(fast.fetchCatalog).toHaveBeenCalledOnce();
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("priority");
    expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(fast.appendEntry).not.toHaveBeenCalled();
  });

  it("invalidates a fresh catalog on auth scope change and recatalogs before resuming", async () => {
    const fast = createFastControllerFixture();
    fast.ctx.sessionManager.getBranch.mockReturnValue([choice("on")]);
    fast.controller.restore(fast.ctx);
    await fast.controller.prepare(fast.ctx);
    fast.readAuthScope.mockResolvedValue("scope-b");
    fast.fetchCatalog.mockResolvedValue({
      authScope: "scope-b",
      data: { models: [{ slug: model.id, service_tiers: [{ id: "default" }] }] },
    });
    await fast.controller.prepare(fast.ctx);
    expect(fast.fetchCatalog).toHaveBeenCalledTimes(2);
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
    expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
      preference: "on",
      eligibility: "unsupported",
      requestPolicy: "suspended",
    });
    fast.readAuthScope.mockResolvedValue("scope-c");
    fast.fetchCatalog.mockResolvedValue({ ...catalog, authScope: "scope-c" });
    await fast.controller.prepare(fast.ctx);
    expect(fast.fetchCatalog).toHaveBeenCalledTimes(3);
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("priority");
    expect(fast.appendEntry).not.toHaveBeenCalled();
  });

  it("rejects a catalog fetched under a different auth scope, preserving the preference for a retry", async () => {
    const fast = createFastControllerFixture();
    fast.ctx.sessionManager.getBranch.mockReturnValue([choice("on")]);
    fast.controller.restore(fast.ctx);
    fast.fetchCatalog.mockResolvedValueOnce({ ...catalog, authScope: "scope-b" });
    await fast.controller.prepare(fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("authentication changed during discovery"),
      "warning",
    );
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
    await fast.controller.prepare(fast.ctx);
    expect(fast.fetchCatalog).toHaveBeenCalledTimes(2);
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("priority");
    expect(fast.appendEntry).not.toHaveBeenCalled();
  });

  it("honors 429 backoff without timers or hook retries and resumes only on later input", async () => {
    const fast = createFastControllerFixture();
    fast.ctx.sessionManager.getBranch.mockReturnValue([choice("on")]);
    fast.controller.restore(fast.ctx);
    fast.fetchCatalog.mockRejectedValueOnce(
      new CodexAccountError("http", "Codex account service is rate limited.", 60_000),
    );
    await fast.controller.prepare(fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("rate limited. Preference unchanged."),
      "warning",
    );
    await fast.controller.prepare(fast.ctx);
    expect(fast.fetchCatalog).toHaveBeenCalledOnce();
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Try again later"),
      "warning",
    );
    fast.clock.now += 60_000;
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
    fast.controller.observe(
      stream({ type: "response.completed", response: { service_tier: "priority" } }),
      fast.ctx,
    );
    expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
      preference: "on",
      requestPolicy: "suspended",
      lastObserved: "priority",
    });
    expect(fast.fetchCatalog).toHaveBeenCalledOnce();
    expect(fast.readAuthScope).toHaveBeenCalledTimes(2);
    await fast.controller.prepare(fast.ctx);
    expect(fast.fetchCatalog).toHaveBeenCalledTimes(2);
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("priority");
    expect(fast.appendEntry).not.toHaveBeenCalled();
  });

  it.each(["auth", "catalog"])(
    "does not display unexpected %s errors or clear a saved-on preference",
    async (source) => {
      const fast = createFastControllerFixture();
      fast.ctx.sessionManager.getBranch.mockReturnValue([choice("on")]);
      fast.controller.restore(fast.ctx);
      await fast.controller.prepare(fast.ctx);
      const error = new Error("private failure details must not appear");
      if (source === "auth") fast.readAuthScope.mockRejectedValueOnce(error);
      else {
        fast.clock.now += 5 * 60_000;
        fast.fetchCatalog.mockRejectedValueOnce(error);
      }
      await fast.controller.prepare(fast.ctx);
      expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
        "Fast mode suspended: Could not prepare Codex fast mode. Preference unchanged.",
        "warning",
      );
      expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
      expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
        preference: "on",
        requestPolicy: "suspended",
      });
      expect(fast.appendEntry).not.toHaveBeenCalled();
    },
  );
});

describe("asynchronous ownership", () => {
  it.each(["model", "session", "leaf"])(
    "discards confirmation after the %s changes",
    async (changed) => {
      const fast = createFastControllerFixture();
      const confirmation = deferred<boolean>();
      fast.ctx.ui.confirm.mockReturnValue(confirmation.promise);
      const enabling = fast.controller.handle("on", fast.ctx);
      if (changed === "model") fast.ctx.model = otherModel;
      if (changed === "session") fast.ctx.sessionManager.getSessionId.mockReturnValue("session-b");
      if (changed === "leaf") fast.ctx.sessionManager.getLeafId.mockReturnValue("leaf-b");
      confirmation.resolve(true);
      await enabling;
      expect(fast.readAuthScope).not.toHaveBeenCalled();
      expect(fast.fetchCatalog).not.toHaveBeenCalled();
      expect(fast.appendEntry).not.toHaveBeenCalled();
      expect(fast.ctx.ui.notify).not.toHaveBeenCalled();
    },
  );

  it.each(["model", "session", "leaf"])(
    "discards catalog discovery after the %s changes",
    async (changed) => {
      const fast = createFastControllerFixture();
      const response = deferred<CodexModelCatalog>();
      const started = deferred<void>();
      fast.fetchCatalog.mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });
      const enabling = fast.controller.handle("on", fast.ctx);
      await started.promise;
      if (changed === "model") fast.ctx.model = otherModel;
      if (changed === "session") fast.ctx.sessionManager.getSessionId.mockReturnValue("session-b");
      if (changed === "leaf") fast.ctx.sessionManager.getLeafId.mockReturnValue("leaf-b");
      response.resolve(catalog);
      await enabling;
      expect(fast.appendEntry).not.toHaveBeenCalled();
      expect(fast.ctx.ui.notify).not.toHaveBeenCalled();
      expect(fast.controller.transform({ model: fast.ctx.model?.id }, fast.ctx)).toBeUndefined();
    },
  );

  it("aborts invalidated discovery without letting a late result clear a newer operation", async () => {
    const fast = createFastControllerFixture();
    const oldCatalog = deferred<CodexModelCatalog>();
    const oldStarted = deferred<void>();
    fast.fetchCatalog.mockImplementationOnce(() => {
      oldStarted.resolve();
      return oldCatalog.promise;
    });
    const oldEnable = fast.controller.handle("on", fast.ctx);
    await oldStarted.promise;
    const oldSignal = fast.fetchCatalog.mock.calls[0][1]!;
    fast.controller.invalidate();
    expect(oldSignal.aborted).toBe(true);
    const confirmation = deferred<boolean>();
    fast.ctx.ui.confirm.mockReturnValueOnce(confirmation.promise);
    const newEnable = fast.controller.handle("on", fast.ctx);
    oldCatalog.resolve(catalog);
    await oldEnable;
    expect(fast.appendEntry).not.toHaveBeenCalled();
    await fast.controller.handle("off", fast.ctx);
    expect(fast.appendEntry).not.toHaveBeenCalled();
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Wait for the current run"),
      "warning",
    );
    confirmation.resolve(true);
    await newEnable;
    expect(fast.appendEntry).toHaveBeenCalledExactlyOnceWith(FAST_ENTRY, {
      provider: model.provider,
      modelId: model.id,
      mode: "on",
    });
  });

  it.each(["resolve", "reject"])(
    "shutdown ignores late confirmation %s before touching expired host getters",
    async (outcome) => {
      const fast = createFastControllerFixture();
      const confirmation = deferred<boolean>();
      fast.ctx.ui.confirm.mockReturnValue(confirmation.promise);
      const enabling = fast.controller.handle("on", fast.ctx);
      const signal = fast.ctx.ui.confirm.mock.calls[0][2]!.signal!;
      const notify = fast.ctx.ui.notify;
      fast.controller.dispose();
      fast.controller.dispose();
      for (const key of ["model", "modelRegistry", "isIdle", "sessionManager", "ui", "hasUI"]) {
        Object.defineProperty(fast.ctx, key, {
          get: () => {
            throw new Error(`Expired ${key}`);
          },
        });
      }
      if (outcome === "resolve") confirmation.resolve(true);
      else confirmation.reject(new Error("private late failure"));
      await enabling;
      expect(signal.aborted).toBe(true);
      expect(notify).not.toHaveBeenCalled();
      expect(fast.readAuthScope).not.toHaveBeenCalled();
      expect(fast.fetchCatalog).not.toHaveBeenCalled();
      expect(fast.appendEntry).not.toHaveBeenCalled();
      expect(fast.controller.getStatus(fast.ctx)).toBeUndefined();
      await fast.controller.handle("on", fast.ctx);
      await fast.controller.prepare(fast.ctx);
      fast.controller.restore(fast.ctx);
      expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
      fast.controller.observe(stream({ type: "response.completed" }), fast.ctx);
    },
  );

  it.each(["resolve", "reject"])(
    "shutdown ignores late catalog %s without accessing the expired host",
    async (outcome) => {
      const fast = createFastControllerFixture();
      const response = deferred<CodexModelCatalog>();
      const started = deferred<void>();
      fast.fetchCatalog.mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });
      const enabling = fast.controller.handle("on", fast.ctx);
      await started.promise;
      const signal = fast.fetchCatalog.mock.calls[0][1]!;
      const notify = fast.ctx.ui.notify;
      fast.controller.dispose();
      for (const key of ["model", "modelRegistry", "isIdle", "sessionManager", "ui"]) {
        Object.defineProperty(fast.ctx, key, {
          get: () => {
            throw new Error(`Expired ${key}`);
          },
        });
      }
      if (outcome === "resolve") response.resolve(catalog);
      else
        response.reject(
          new CodexAccountError("http", "Codex account service is rate limited.", 60_000),
        );
      await enabling;
      expect(signal.aborted).toBe(true);
      expect(notify).not.toHaveBeenCalled();
      expect(fast.appendEntry).not.toHaveBeenCalled();
    },
  );

  it("shutdown stops a saved-on auth check before any late catalog IO or host access", async () => {
    const fast = createFastControllerFixture();
    fast.ctx.sessionManager.getBranch.mockReturnValue([choice("on")]);
    fast.controller.restore(fast.ctx);
    const scope = deferred<string>();
    fast.readAuthScope.mockReturnValueOnce(scope.promise);
    const preparing = fast.controller.prepare(fast.ctx);
    const signal = fast.readAuthScope.mock.calls[0][1]!;
    const notify = fast.ctx.ui.notify;
    fast.controller.dispose();
    for (const key of ["model", "modelRegistry", "isIdle", "sessionManager", "ui"]) {
      Object.defineProperty(fast.ctx, key, {
        get: () => {
          throw new Error(`Expired ${key}`);
        },
      });
    }
    scope.resolve("scope-a");
    await preparing;
    expect(signal.aborted).toBe(true);
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(fast.appendEntry).not.toHaveBeenCalled();
  });
});

describe("provider stream observations", () => {
  it("reports an observed default independently of the priority payload and next-request policy", async () => {
    const fast = createFastControllerFixture();
    await fast.controller.handle("on", fast.ctx);
    const payload = Object.freeze({ model: model.id, input: [], service_tier: "priority" });
    const transformed = fast.controller.transform(payload, fast.ctx);
    expect(transformed).toBeUndefined();
    expect(transformed ?? payload).toEqual({
      model: model.id,
      input: [],
      service_tier: "priority",
    });
    fast.controller.observe(
      stream({ type: "response.completed", response: { service_tier: "default" } }),
      fast.ctx,
    );
    expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
      preference: "on",
      requestPolicy: "priority",
      lastObserved: "default",
    });
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("priority");
    expect(fast.fetchCatalog).toHaveBeenCalledOnce();
    expect(fast.readAuthScope).toHaveBeenCalledOnce();
  });

  it.each([
    { type: "response.done", response: {} },
    { type: "response.incomplete", response: { service_tier: "unrecognized-tier" } },
  ])("reports missing or unrecognized terminal tier metadata as unknown: %j", async (data) => {
    const fast = createFastControllerFixture();
    await fast.controller.handle("off", fast.ctx);
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toEqual({
      model: model.id,
      service_tier: "default",
    });
    fast.controller.observe(
      stream({ type: "response.completed", response: { service_tier: "default" } }),
      fast.ctx,
    );
    fast.controller.observe(stream(data), fast.ctx);
    expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
      requestPolicy: "default",
      lastObserved: undefined,
    });
    expect(fast.readAuthScope).not.toHaveBeenCalled();
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
  });

  it("ignores wrong-model and nonterminal events, and does not show delivery from another session", async () => {
    const fast = createFastControllerFixture();
    await fast.controller.handle("off", fast.ctx);
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toEqual({
      model: model.id,
      service_tier: "default",
    });
    fast.controller.observe(
      stream({ type: "response.completed", response: { service_tier: "default" } }),
      fast.ctx,
    );
    fast.controller.observe(
      {
        ...stream({ type: "response.completed", response: { service_tier: "priority" } }),
        model: otherModel.id,
      },
      fast.ctx,
    );
    fast.controller.observe(
      stream({ type: "response.created", response: { service_tier: "priority" } }),
      fast.ctx,
    );
    expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
      requestPolicy: "default",
      lastObserved: "default",
    });
    fast.ctx.sessionManager.getSessionId.mockReturnValue("session-b");
    fast.controller.observe(
      stream({ type: "response.completed", response: { service_tier: "priority" } }),
      fast.ctx,
    );
    expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
      requestPolicy: "default",
      lastObserved: undefined,
    });
  });
});

function choice(mode: FastPreference, selected = model): Extract<SessionEntry, { type: "custom" }> {
  return {
    type: "custom",
    id: `${selected.id}-${mode}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    customType: FAST_ENTRY,
    data: { provider: selected.provider, modelId: selected.id, mode },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createFastControllerFixture() {
  const clock = { now: 1_000 };
  const registry = {
    getProvider: vi.fn<FastHost["modelRegistry"]["getProvider"]>(() => ({
      baseUrl: model.baseUrl,
      getModels: () => [model, otherModel],
    })),
    isUsingOAuth: vi.fn<FastHost["modelRegistry"]["isUsingOAuth"]>(() => true),
    getRegisteredProviderConfig: vi.fn<FastHost["modelRegistry"]["getRegisteredProviderConfig"]>(
      () => undefined,
    ),
    getRegisteredNativeProvider: vi.fn<FastHost["modelRegistry"]["getRegisteredNativeProvider"]>(
      () => undefined,
    ),
    getProviderAuth: vi.fn<FastHost["modelRegistry"]["getProviderAuth"]>(async () => undefined),
  };
  const ctx = {
    model: model as FastHost["model"],
    modelRegistry: registry,
    hasUI: true as FastHost["hasUI"],
    isIdle: vi.fn<FastHost["isIdle"]>(() => true),
    ui: {
      notify: vi.fn<FastHost["ui"]["notify"]>(),
      confirm: vi.fn<FastHost["ui"]["confirm"]>(async () => true),
    },
    sessionManager: {
      getBranch: vi.fn<FastHost["sessionManager"]["getBranch"]>(() => []),
      getSessionId: vi.fn(() => "session-a"),
      getLeafId: vi.fn<FastHost["sessionManager"]["getLeafId"]>(() => "leaf-a"),
    },
  } satisfies FastHost;
  const appendEntry = vi.fn<ExtensionAPI["appendEntry"]>();
  const fetchCatalog = vi.fn<typeof fetchCodexModelCatalog>(async () => catalog);
  const readAuthScope = vi.fn<typeof readCodexAuthScope>(async () => "scope-a");
  const controller = new FastController(
    { appendEntry },
    "eleith:codex",
    fetchCatalog,
    readAuthScope,
    () => clock.now,
  );
  return { controller, ctx, appendEntry, fetchCatalog, readAuthScope, clock };
}

function stream(data: unknown): ProviderStreamEvent {
  return {
    type: "provider_stream_event",
    provider: model.provider,
    api: model.api,
    model: model.id,
    data,
  };
}
