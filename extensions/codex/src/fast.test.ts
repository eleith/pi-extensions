import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ProviderStreamEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CodexAccountError, type fetchCodexModelCatalog } from "./client.ts";
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
const catalog = {
  models: [{ slug: model.id, service_tiers: [{ id: "default" }, { id: "priority" }] }],
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
        requestPolicy: "priority",
      });
      expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
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
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
  });

  it("rejects mutations during a run without prompting or IO", async () => {
    const fast = createFastControllerFixture();
    fast.ctx.isIdle.mockReturnValue(false);
    for (const action of ["on", "off", "toggle"]) await fast.controller.handle(action, fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Wait for the current run"),
      "warning",
    );
    expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
    expect(fast.appendEntry).not.toHaveBeenCalled();
  });

  it("reports a missing selection rather than confirming or persisting a choice", async () => {
    const fast = createFastControllerFixture();
    fast.ctx.model = undefined;
    await fast.controller.handle("on", fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith("No model selected.", "warning");
    expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
    expect(fast.appendEntry).not.toHaveBeenCalled();
  });

  it("persists on only after cost confirmation and matching catalog discovery complete", async () => {
    const fast = createFastControllerFixture();
    const confirmation = deferred<boolean>();
    const response = deferred<unknown>();
    const started = deferred<void>();
    fast.ctx.ui.confirm.mockReturnValue(confirmation.promise);
    fast.fetchCatalog.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const enabling = fast.controller.handle("  ON  ", fast.ctx);
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
    expect(fast.appendEntry).not.toHaveBeenCalled();
    await fast.controller.handle("off", fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Wait for the current run"),
      "warning",
    );
    confirmation.resolve(true);
    await started.promise;
    expect(fast.fetchCatalog).toHaveBeenCalledExactlyOnceWith(
      fast.ctx.modelRegistry,
      expect.any(AbortSignal),
    );
    // The account client resolves auth for its one request; no separate preflight.
    expect(fast.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
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
    {
      data: { models: [{ slug: otherModel.id, service_tiers: [{ id: "priority" }] }] },
      reason: "did not establish",
    },
    {
      data: { models: [{ slug: model.id, service_tiers: [{ id: "default" }] }] },
      reason: "does not advertise",
    },
  ])("does not enable without established model support: %j", async ({ data, reason }) => {
    const fast = createFastControllerFixture();
    fast.fetchCatalog.mockResolvedValue(data);
    await fast.controller.handle("on", fast.ctx);
    expect(fast.appendEntry).not.toHaveBeenCalled();
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(reason), "warning");
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Preference unchanged"),
      "warning",
    );
  });

  it("treats an already saved on as idempotent without confirmation or discovery", async () => {
    const fast = createFastControllerFixture();
    fast.ctx.sessionManager.getBranch.mockReturnValue([choice("on")]);
    fast.controller.restore(fast.ctx);
    fast.ctx.hasUI = false;
    await fast.controller.handle("on", fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Fast: On (priority requested)"),
      "info",
    );
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
    expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(fast.appendEntry).not.toHaveBeenCalled();
  });

  it("copies a frozen payload for explicit default and restores a legacy inherit entry", async () => {
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
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
    expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
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
      expect(fast.controller.getStatus(fast.ctx)).toMatchObject({ conflict: false });
    },
  );

  it("toggle confirms only transitions to on and preserves off if confirmation is declined", async () => {
    const fast = createFastControllerFixture();
    await fast.controller.handle("toggle", fast.ctx);
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

  it("honors server Retry-After only for explicit enable attempts, without automatic retries", async () => {
    const fast = createFastControllerFixture();
    fast.fetchCatalog.mockRejectedValueOnce(
      new CodexAccountError("http", "Codex account service is rate limited.", 60_000),
    );
    await fast.controller.handle("on", fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Codex account service is rate limited. Preference unchanged.",
      "warning",
    );
    await fast.controller.handle("on", fast.ctx);
    expect(fast.fetchCatalog).toHaveBeenCalledOnce();
    expect(fast.ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Try fast on again later"),
      "warning",
    );
    fast.clock.now += 60_000;
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
    expect(fast.fetchCatalog).toHaveBeenCalledOnce();
    await fast.controller.handle("on", fast.ctx);
    expect(fast.fetchCatalog).toHaveBeenCalledTimes(2);
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("priority");
  });

  it("does not expose unexpected discovery errors or change an existing off preference", async () => {
    const fast = createFastControllerFixture();
    await fast.controller.handle("off", fast.ctx);
    fast.fetchCatalog.mockRejectedValueOnce(new Error("private failure details must not appear"));
    await fast.controller.handle("on", fast.ctx);
    expect(fast.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Could not enable Codex fast mode. Preference unchanged.",
      "warning",
    );
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("default");
    expect(fast.appendEntry).toHaveBeenCalledOnce();
  });
});

describe("durable branch preferences", () => {
  it("replays the active branch immediately without discovery, keeping model and context choices separate", () => {
    const fast = createFastControllerFixture();
    fast.ctx.sessionManager.getBranch.mockReturnValue([
      choice("off"),
      choice("on"),
      choice("off", otherModel),
      { ...choice("off"), customType: CONTEXT_ENTRY },
    ]);
    fast.controller.restore(fast.ctx);
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
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
    expect(fast.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
    expect(fast.appendEntry).not.toHaveBeenCalled();
    expect(fast.ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("keeps priority after five minutes, days, invalidation and reload without any preflight", async () => {
    const fast = createFastControllerFixture();
    await fast.controller.handle("on", fast.ctx);
    fast.fetchCatalog.mockRejectedValue(new Error("Catalog must not be needed again"));
    fast.ctx.modelRegistry.getProviderAuth.mockRejectedValue(new Error("No auth preflight"));
    fast.ctx.isIdle.mockReturnValue(false);
    for (const elapsed of [5 * 60_000, 24 * 60 * 60_000]) {
      fast.clock.now += elapsed;
      expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe(
        "priority",
      );
      expect(fast.controller.getStatus(fast.ctx)).toMatchObject({ requestPolicy: "priority" });
    }
    fast.controller.invalidate();
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("priority");
    fast.ctx.sessionManager.getBranch.mockReturnValue([choice("on")]);
    const reloaded = new FastController(
      { appendEntry: fast.appendEntry },
      "eleith:codex",
      fast.fetchCatalog,
    );
    reloaded.restore(fast.ctx);
    expect(reloaded.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("priority");
    expect(fast.fetchCatalog).toHaveBeenCalledOnce();
    expect(fast.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
    expect(fast.ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(fast.ctx.ui.notify).toHaveBeenCalledOnce();
  });

  it("keeps saved on while outside scope and resumes it when the direct selection returns", () => {
    const fast = createFastControllerFixture();
    fast.ctx.sessionManager.getBranch.mockReturnValue([choice("on")]);
    fast.controller.restore(fast.ctx);
    fast.ctx.modelRegistry.isUsingOAuth.mockReturnValue(false);
    expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
      preference: "on",
      requestPolicy: "outside scope",
    });
    expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
    fast.ctx.modelRegistry.isUsingOAuth.mockReturnValue(true);
    fast.controller.invalidate();
    expect(fast.controller.transform({ model: model.id }, fast.ctx)?.service_tier).toBe("priority");
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
    expect(fast.appendEntry).not.toHaveBeenCalled();
  });
});

describe("asynchronous enable ownership", () => {
  it.each(["model", "session", "leaf"])(
    "discards confirmation after the %s changes",
    async (changed) => {
      const fast = createFastControllerFixture();
      const confirmation = deferred<boolean>();
      fast.ctx.ui.confirm.mockReturnValue(confirmation.promise);
      const enabling = fast.controller.handle("on", fast.ctx);
      changeSelection(fast, changed);
      confirmation.resolve(true);
      await enabling;
      expect(fast.fetchCatalog).not.toHaveBeenCalled();
      expect(fast.appendEntry).not.toHaveBeenCalled();
      expect(fast.ctx.ui.notify).not.toHaveBeenCalled();
    },
  );

  it.each(["model", "session", "leaf"])(
    "discards catalog discovery after the %s changes",
    async (changed) => {
      const fast = createFastControllerFixture();
      const response = deferred<unknown>();
      const started = deferred<void>();
      fast.fetchCatalog.mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });
      const enabling = fast.controller.handle("on", fast.ctx);
      await started.promise;
      changeSelection(fast, changed);
      response.resolve(catalog);
      await enabling;
      expect(fast.appendEntry).not.toHaveBeenCalled();
      expect(fast.ctx.ui.notify).not.toHaveBeenCalled();
      expect(fast.controller.transform({ model: fast.ctx.model?.id }, fast.ctx)).toBeUndefined();
    },
  );

  it("aborts invalidated discovery without letting a late result clear a newer operation", async () => {
    const fast = createFastControllerFixture();
    const oldCatalog = deferred<unknown>();
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

  it.each(["confirmation", "catalog"])(
    "shutdown ignores late %s results before touching expired host getters",
    async (stage) => {
      for (const outcome of ["resolve", "reject"]) {
        const fast = createFastControllerFixture();
        const confirmation = deferred<boolean>();
        const response = deferred<unknown>();
        const started = deferred<void>();
        if (stage === "confirmation") fast.ctx.ui.confirm.mockReturnValue(confirmation.promise);
        fast.fetchCatalog.mockImplementationOnce(() => {
          started.resolve();
          return response.promise;
        });
        const enabling = fast.controller.handle("on", fast.ctx);
        if (stage === "catalog") await started.promise;
        const signal =
          stage === "confirmation"
            ? fast.ctx.ui.confirm.mock.calls[0][2]!.signal!
            : fast.fetchCatalog.mock.calls[0][1]!;
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
        if (stage === "confirmation") {
          if (outcome === "resolve") confirmation.resolve(true);
          else confirmation.reject(new Error("private late failure"));
        } else {
          if (outcome === "resolve") response.resolve(catalog);
          else response.reject(new CodexAccountError("http", "private late failure", 60_000));
        }
        await enabling;
        expect(signal.aborted).toBe(true);
        expect(notify).not.toHaveBeenCalled();
        expect(fast.appendEntry).not.toHaveBeenCalled();
        expect(fast.controller.getStatus(fast.ctx)).toBeUndefined();
        await fast.controller.handle("on", fast.ctx);
        fast.controller.restore(fast.ctx);
        expect(fast.controller.transform({ model: model.id }, fast.ctx)).toBeUndefined();
        fast.controller.observe(stream({ type: "response.completed" }), fast.ctx);
      }
    },
  );
});

describe("provider stream observations", () => {
  it("reports observed default independently of the priority request without disabling future requests", async () => {
    const fast = createFastControllerFixture();
    await fast.controller.handle("on", fast.ctx);
    const payload = Object.freeze({ model: model.id, input: [], service_tier: "priority" });
    expect(fast.controller.transform(payload, fast.ctx)).toBeUndefined();
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
  });

  it.each([
    { type: "response.done", response: {} },
    { type: "response.incomplete", response: { service_tier: "unrecognized-tier" } },
  ])("reports missing or unrecognized terminal tier metadata as unknown: %j", async (data) => {
    const fast = createFastControllerFixture();
    await fast.controller.handle("off", fast.ctx);
    fast.controller.transform({ model: model.id }, fast.ctx);
    fast.controller.observe(
      stream({ type: "response.completed", response: { service_tier: "default" } }),
      fast.ctx,
    );
    fast.controller.observe(stream(data), fast.ctx);
    expect(fast.controller.getStatus(fast.ctx)).toMatchObject({
      requestPolicy: "default",
      lastObserved: undefined,
    });
    expect(fast.fetchCatalog).not.toHaveBeenCalled();
  });

  it("ignores wrong-model and nonterminal events, and delivery from another session", async () => {
    const fast = createFastControllerFixture();
    await fast.controller.handle("off", fast.ctx);
    fast.controller.transform({ model: model.id }, fast.ctx);
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
  const controller = new FastController(
    { appendEntry },
    "eleith:codex",
    fetchCatalog,
    () => clock.now,
  );
  return { controller, ctx, appendEntry, fetchCatalog, clock };
}

function changeSelection(fast: ReturnType<typeof createFastControllerFixture>, changed: string) {
  if (changed === "model") fast.ctx.model = otherModel;
  if (changed === "session") fast.ctx.sessionManager.getSessionId.mockReturnValue("session-b");
  if (changed === "leaf") fast.ctx.sessionManager.getLeafId.mockReturnValue("leaf-b");
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
