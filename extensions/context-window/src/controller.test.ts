import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ContextController, type ContextAPI, type ContextHost } from "./controller.ts";
import { CONTEXT_ENTRY, type ContextPreference } from "./state.ts";

function model(id = "gpt-6-sol", provider = "openai-codex"): Model<Api> {
  return {
    id,
    provider,
    name: id,
    api: "openai-codex-responses",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  };
}

function preference(extended: boolean, modelId = "gpt-6-sol"): ContextPreference {
  return { provider: "openai-codex", modelId, extended };
}

function entry(data: unknown, customType = CONTEXT_ENTRY): SessionEntry {
  return {
    type: "custom",
    id: "preference",
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    customType,
    data,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Pi emits model_select only for provider/ID changes, not same-ID metadata.
// The catalog remains separate from selected copies; no provider is involved.
function fixture(catalog = model()) {
  const state = {
    current: catalog as Model<Api> | undefined,
    thinking: "medium" as ReturnType<ContextAPI["getThinkingLevel"]>,
    branch: [] as SessionEntry[],
    idle: true,
    hasUI: true,
    sessionId: "session-a",
    leafId: "leaf-a" as string | null,
    usage: { tokens: 100_000, contextWindow: 272_000, percent: null } as ReturnType<
      ContextHost["getContextUsage"]
    >,
    catalog: catalog as Model<Api> | undefined,
    cloneSelection: false,
    accepted: true,
    staleReads: 0,
  };
  const notify = vi.fn<ContextHost["ui"]["notify"]>();
  const confirm = vi.fn<ContextHost["ui"]["confirm"]>(async () => true);

  function host() {
    let live = true;
    function check() {
      if (!live) {
        state.staleReads++;
        throw new Error("Expired root context accessed");
      }
    }
    const ctx: ContextHost = {
      get model() {
        check();
        return state.current;
      },
      get modelRegistry() {
        check();
        return { find: () => state.catalog };
      },
      get hasUI() {
        check();
        return state.hasUI;
      },
      isIdle() {
        check();
        return state.idle;
      },
      getContextUsage() {
        check();
        return state.usage;
      },
      get ui() {
        check();
        return { notify, confirm };
      },
      get sessionManager() {
        check();
        return {
          getBranch() {
            check();
            return state.branch;
          },
          getSessionId() {
            check();
            return state.sessionId;
          },
          getLeafId() {
            check();
            return state.leafId;
          },
        };
      },
    };
    return {
      ctx,
      expire() {
        live = false;
      },
    };
  }

  let active = host();
  async function assign(copy: Model<Api>) {
    const previous = state.current;
    state.current = state.cloneSelection ? structuredClone(copy) : copy;
    state.thinking = "off";
    if (previous?.provider !== copy.provider || previous?.id !== copy.id)
      await controller.modelSelected(active.ctx);
  }
  const api = {
    setModel: vi.fn<ContextAPI["setModel"]>(async (copy) => {
      if (!state.accepted) return false;
      await assign(copy);
      return true;
    }),
    getThinkingLevel: vi.fn<ContextAPI["getThinkingLevel"]>(() => state.thinking),
    setThinkingLevel: vi.fn<ContextAPI["setThinkingLevel"]>((thinking) => {
      state.thinking = thinking;
    }),
    appendEntry: vi.fn<ContextAPI["appendEntry"]>((customType, data) => {
      state.branch.push(entry(data, customType));
    }),
  } satisfies ContextAPI;
  const controller = new ContextController(api, "personal:context");
  return {
    catalog,
    state,
    api,
    controller,
    notify,
    confirm,
    assign,
    get ctx() {
      return active.ctx;
    },
    expire() {
      active.expire();
    },
    replaceRoot() {
      active.expire();
      active = host();
      return active.ctx;
    },
  };
}

describe("ContextController", () => {
  it.each([false, true])(
    "extends with retained/cloned outcome %s, preserving metadata and thinking",
    async (clone) => {
      const f = fixture();
      f.state.cloneSelection = clone;
      const original = structuredClone(f.catalog);
      await f.controller.handle(" EXTEND ", f.ctx);

      expect(f.state.current).not.toBe(f.catalog);
      expect(f.state.current).toEqual({ ...original, contextWindow: 922_000 });
      expect(f.catalog).toEqual(original);
      expect(f.state.thinking).toBe("medium");
      expect(f.api.setThinkingLevel).toHaveBeenCalledWith("medium");
      expect(f.api.appendEntry).toHaveBeenCalledExactlyOnceWith(CONTEXT_ENTRY, preference(true));
      expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("922,000 tokens"), "info");

      await f.controller.handle("extend", f.ctx);
      expect(f.api.setModel).toHaveBeenCalledTimes(1);
      expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
    },
  );

  it.each([null, "original"])(
    "allows setModel metadata to advance leaf %s",
    async (previousLeaf) => {
      const f = fixture();
      f.state.leafId = previousLeaf;
      f.state.branch = previousLeaf === null ? [] : [{ ...entry(null), id: previousLeaf }];
      f.api.setModel.mockImplementationOnce(async (copy) => {
        await f.assign(copy);
        const timestamp = "2026-01-01T00:00:00Z";
        f.state.branch.push(
          {
            type: "model_change",
            id: "model-change",
            parentId: previousLeaf,
            timestamp,
            provider: copy.provider,
            modelId: copy.id,
          },
          {
            type: "thinking_level_change",
            id: "thinking-change",
            parentId: "model-change",
            timestamp,
            thinkingLevel: "off",
          },
        );
        f.state.leafId = "thinking-change";
        return true;
      });
      await f.controller.handle("extend", f.ctx);
      expect(f.state.current?.contextWindow).toBe(922_000);
      expect(f.catalog.contextWindow).toBe(272_000);
      expect(f.state.thinking).toBe("medium");
      expect(f.api.appendEntry).toHaveBeenCalledExactlyOnceWith(CONTEXT_ENTRY, preference(true));
    },
  );

  it("confirms restore without mutating any previous copy", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    const extended = f.state.current!;
    f.state.thinking = "high";
    await f.controller.handle("restore", f.ctx);

    expect(f.confirm).toHaveBeenCalledWith(
      "Use standard context?",
      expect.stringContaining("922,000 → 272,000"),
      { signal: expect.any(AbortSignal) },
    );
    expect(f.state.current).not.toBe(extended);
    expect(f.state.current?.contextWindow).toBe(272_000);
    expect(extended.contextWindow).toBe(922_000);
    expect(f.catalog.contextWindow).toBe(272_000);
    expect(f.state.thinking).toBe("high");
    expect(f.api.appendEntry).toHaveBeenLastCalledWith(CONTEXT_ENTRY, preference(false));
    expect(f.api.setModel).toHaveBeenCalledTimes(2);

    f.controller.shutdown();
    expect(f.api.setModel).toHaveBeenCalledTimes(2);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(2);
  });

  it("shutdown leaves selected metadata untouched with no API or transcript writes", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    const owned = f.state.current!;
    f.api.setModel.mockClear();
    f.api.appendEntry.mockClear();
    f.api.setThinkingLevel.mockClear();
    f.expire();
    f.controller.shutdown();
    f.controller.shutdown();
    await f.controller.restore(f.ctx);
    await f.controller.modelSelected(f.ctx);
    await f.controller.reconcile(f.ctx);
    await f.controller.handle("extend", f.ctx);

    expect(owned.contextWindow).toBe(922_000);
    expect(f.catalog.contextWindow).toBe(272_000);
    expect(f.api.setModel).not.toHaveBeenCalled();
    expect(f.api.appendEntry).not.toHaveBeenCalled();
    expect(f.api.setThinkingLevel).not.toHaveBeenCalled();
    expect(f.state.staleReads).toBe(0);
  });

  it("authentication refusal leaves the model and branch preference untouched", async () => {
    const f = fixture();
    f.state.accepted = false;
    await f.controller.handle("extend", f.ctx);
    expect(f.state.current).toBe(f.catalog);
    expect(f.catalog.contextWindow).toBe(272_000);
    expect(f.api.appendEntry).not.toHaveBeenCalled();
    expect(f.api.setThinkingLevel).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledWith(
      expect.stringContaining("authentication is unavailable"),
      "warning",
    );

    f.state.accepted = true;
    await f.controller.handle("extend", f.ctx);
    expect(f.state.current?.contextWindow).toBe(922_000);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("authentication refusal during replay does not retry on later idle hooks", async () => {
    const f = fixture();
    f.state.branch = [entry(preference(true))];
    f.state.accepted = false;
    await f.controller.restore(f.ctx);
    f.state.accepted = true;
    await f.controller.reconcile(f.ctx);
    await f.controller.modelSelected(f.ctx);
    expect(f.api.setModel).toHaveBeenCalledTimes(1);
    expect(f.api.appendEntry).not.toHaveBeenCalled();
    await f.controller.handle("extend", f.ctx);
    expect(f.state.current?.contextWindow).toBe(922_000);
    expect(f.state.thinking).toBe("medium");
    expect(f.api.setModel).toHaveBeenCalledTimes(2);
    // The saved desired preference was already true; no redundant record.
    expect(f.api.appendEntry).not.toHaveBeenCalled();
  });

  it("busy runs reject changes without opening a dialog or writing preferences", async () => {
    const f = fixture();
    f.state.idle = false;
    await f.controller.handle("extend", f.ctx);
    await f.controller.handle("restore", f.ctx);
    expect(f.api.setModel).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.api.appendEntry).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Wait for the current run"),
      "warning",
    );
  });

  it("cancelled reduction leaves the extended copy and preference intact", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    const owned = f.state.current;
    f.confirm.mockResolvedValueOnce(false);
    await f.controller.handle("restore", f.ctx);
    expect(f.state.current).toBe(owned);
    expect(owned?.contextWindow).toBe(922_000);
    expect(f.api.setModel).toHaveBeenCalledTimes(1);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);

    await f.controller.handle("restore", f.ctx);
    expect(f.state.current?.contextWindow).toBe(272_000);
  });

  it("usage above the target requires compaction before a reduction dialog", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    f.state.usage = { tokens: 272_001, contextWindow: 922_000, percent: null };
    await f.controller.handle("restore", f.ctx);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.api.setModel).toHaveBeenCalledTimes(1);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
    expect(f.state.current?.contextWindow).toBe(922_000);
    expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("Run /compact"), "warning");
  });

  it("no UI blocks reduction, even when usage is unknown", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    f.state.hasUI = false;
    f.state.usage = undefined;
    await f.controller.handle("restore", f.ctx);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.api.setModel).toHaveBeenCalledTimes(1);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
    expect(f.state.current?.contextWindow).toBe(922_000);
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("interactive confirmation"),
      "warning",
    );
  });

  it("restores only valid preferences on the active branch for the selected model", async () => {
    const f = fixture();
    // This abandoned choice must not survive restore of the active branch.
    f.state.branch = [entry(preference(true))];
    f.state.idle = false;
    await f.controller.restore(f.ctx);
    f.state.branch = [
      entry(preference(false)),
      entry({ ...preference(true), extended: "true" }),
      entry(preference(true), "another-extension"),
      entry(preference(true, "gpt-6-astra")),
    ];
    f.state.idle = true;
    await f.controller.restore(f.ctx);
    expect(f.state.current).toBe(f.catalog);
    expect(f.api.setModel).not.toHaveBeenCalled();
    expect(f.api.appendEntry).not.toHaveBeenCalled();

    f.state.branch.push(entry(preference(true)), entry(null));
    await f.controller.restore(f.ctx);
    expect(f.state.current?.contextWindow).toBe(922_000);
    expect(f.api.appendEntry).not.toHaveBeenCalled();
    expect(f.catalog.contextWindow).toBe(272_000);
  });

  it("defers standard-branch restoration until idle and confirms the reduction", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    f.state.branch = [entry(preference(false))];
    f.state.idle = false;
    await f.controller.restore(f.ctx);
    await f.controller.reconcile(f.ctx);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.state.current?.contextWindow).toBe(922_000);

    const answer = deferred<boolean>();
    f.confirm.mockReturnValueOnce(answer.promise);
    f.state.idle = true;
    const restoration = f.controller.reconcile(f.ctx);
    await f.controller.handle("extend", f.ctx);
    expect(f.api.setModel).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Wait for the current run"),
      "warning",
    );
    answer.resolve(true);
    await restoration;
    expect(f.state.current?.contextWindow).toBe(272_000);
    // Reconciliation applies a saved choice, not a new transcript preference.
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("declining branch reconciliation remembers extended on that branch", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    f.state.branch = [];
    f.confirm.mockResolvedValueOnce(false);
    await f.controller.restore(f.ctx);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(2);
    expect(f.api.appendEntry).toHaveBeenLastCalledWith(CONTEXT_ENTRY, preference(true));
    expect(f.notify).toHaveBeenLastCalledWith("Keeping extended context on this branch.", "info");
    await f.controller.reconcile(f.ctx);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.state.current?.contextWindow).toBe(922_000);
  });

  it("shutdown aborts the confirmation signal without accessing the expired root", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    const answer = deferred<boolean>();
    f.confirm.mockReturnValueOnce(answer.promise);
    const request = f.controller.handle("restore", f.ctx);
    const signal = f.confirm.mock.calls[0][2]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    f.controller.shutdown();
    f.expire();
    f.notify.mockClear();
    answer.resolve(true);
    await request;
    expect(signal?.aborted).toBe(true);
    expect(f.state.staleReads).toBe(0);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.state.current?.contextWindow).toBe(922_000);
    expect(f.api.setModel).toHaveBeenCalledTimes(1);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
  });

  it.each(["model", "tree", "session", "shutdown"] as const)(
    "%s invalidates a dialog without expired getters or fabricated decline preferences",
    async (event) => {
      const f = fixture();
      await f.controller.handle("extend", f.ctx);
      const extended = f.state.current!;
      f.state.branch = [];
      const answer = deferred<boolean>();
      f.confirm.mockReturnValueOnce(answer.promise);
      const request = f.controller.restore(f.ctx);
      const signal = f.confirm.mock.calls[0][2]?.signal;
      const live = f.replaceRoot();
      if (event === "model") {
        f.state.current = model("other", "other");
        await f.controller.modelSelected(live);
      } else if (event === "shutdown") f.controller.shutdown(live);
      else {
        if (event === "session") f.state.sessionId = "session-b";
        await f.controller.restore(live);
      }
      expect(signal?.aborted).toBe(true);
      expect(f.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("Automatic replay is paused"),
        "warning",
      );
      f.notify.mockClear();
      answer.resolve(false);
      await request;
      expect(f.state.staleReads).toBe(0);
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
      expect(extended.contextWindow).toBe(922_000);
      await f.controller.reconcile(f.ctx);
      expect(f.confirm).toHaveBeenCalledTimes(1);
      if (event !== "shutdown") {
        f.state.current = extended;
        await f.controller.handle("restore", f.ctx);
        expect(f.state.current?.contextWindow).toBe(272_000);
      }
    },
  );

  it.each(["sessionId", "leafId", "model", "idle"] as const)(
    "rejects even a declined confirmation after %s changes",
    async (key) => {
      const f = fixture();
      await f.controller.handle("extend", f.ctx);
      f.state.branch = [];
      const answer = deferred<boolean>();
      f.confirm.mockReturnValueOnce(answer.promise);
      const request = f.controller.restore(f.ctx);
      if (key === "model") f.state.current = { ...f.state.current!, maxTokens: 100 };
      else if (key === "idle") f.state.idle = false;
      else f.state[key] = "changed";
      answer.resolve(false);
      await request;
      expect(f.api.setModel).toHaveBeenCalledTimes(1);
      expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
      expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("uncertain"), "warning");
    },
  );

  it.each([undefined, { tokens: null, contextWindow: 922_000, percent: null }])(
    "confirms reduction with unknown usage %j without inventing zero",
    async (usage) => {
      const f = fixture();
      await f.controller.handle("extend", f.ctx);
      f.state.usage = usage;
      await f.controller.handle("restore", f.ctx);
      expect(f.confirm).toHaveBeenCalledWith(
        "Use standard context?",
        expect.stringContaining("usage: unknown"),
        expect.anything(),
      );
      expect(f.state.current?.contextWindow).toBe(272_000);
    },
  );

  it("accepts a frozen submitted copy and leaves shared nested catalog metadata untouched", async () => {
    const f = fixture();
    const original = structuredClone(f.catalog);
    Object.freeze(f.catalog.cost);
    Object.freeze(f.catalog.input);
    Object.freeze(f.catalog);
    f.api.setModel.mockImplementation(async (copy) => {
      Object.freeze(copy);
      await f.assign(copy);
      return true;
    });
    await f.controller.handle("extend", f.ctx);
    const extended = f.state.current!;
    expect(extended.cost).toBe(f.catalog.cost);
    await f.controller.handle("restore", f.ctx);
    expect(f.state.current?.contextWindow).toBe(272_000);
    expect(extended.contextWindow).toBe(922_000);
    expect(f.catalog).toEqual(original);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(2);
    f.controller.shutdown();
    expect(extended.contextWindow).toBe(922_000);
  });

  it("compares captured values even when another writer mutates a retained submitted object", async () => {
    const f = fixture();
    f.api.setModel.mockImplementationOnce(async (copy) => {
      await f.assign(copy);
      // Simulate a different writer: retaining the input is not an ownership contract.
      copy.contextWindow = 800_000;
      return true;
    });
    await f.controller.handle("extend", f.ctx);
    expect(f.state.current?.contextWindow).toBe(800_000);
    expect(f.api.appendEntry).not.toHaveBeenCalled();
    expect(f.api.setThinkingLevel).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("uncertain"), "warning");
  });

  it("an expired dialog's finally cannot clear a newer explicit request", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    const oldAnswer = deferred<boolean>();
    const newAnswer = deferred<boolean>();
    f.confirm.mockReturnValueOnce(oldAnswer.promise).mockReturnValueOnce(newAnswer.promise);
    const oldRequest = f.controller.handle("restore", f.ctx);
    await f.controller.restore(f.replaceRoot());
    const newRequest = f.controller.handle("restore", f.ctx);
    oldAnswer.resolve(false);
    await oldRequest;
    await f.controller.handle("extend", f.ctx);
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Wait for the current run"),
      "warning",
    );
    expect(f.api.setModel).toHaveBeenCalledTimes(1);
    newAnswer.resolve(true);
    await newRequest;
    expect(f.state.staleReads).toBe(0);
    expect(f.state.current?.contextWindow).toBe(272_000);
    expect(f.api.appendEntry).toHaveBeenLastCalledWith(CONTEXT_ENTRY, preference(false));
  });

  it("rechecks usage after confirmation", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    f.confirm.mockImplementationOnce(async () => {
      f.state.usage = { tokens: 300_000, contextWindow: 922_000, percent: null };
      return true;
    });
    await f.controller.handle("restore", f.ctx);
    expect(f.api.setModel).toHaveBeenCalledTimes(1);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("Run /compact"), "warning");
  });

  it.each(["usage", "noUI"] as const)(
    "blocked replay %s cannot remember keep-extended",
    async (reason) => {
      const f = fixture();
      await f.controller.handle("extend", f.ctx);
      f.state.branch = [];
      if (reason === "usage")
        f.state.usage = { tokens: 300_000, contextWindow: 922_000, percent: null };
      else f.state.hasUI = false;
      await f.controller.restore(f.ctx);
      expect(f.confirm).not.toHaveBeenCalled();
      expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["sessionId", "leafId", "metadata", "cloneMismatch"] as const)(
    "reports a completed setModel with %s interference without rollback or replay",
    async (key) => {
      const f = fixture();
      const assigned = deferred<void>();
      const finish = deferred<boolean>();
      f.api.setModel.mockImplementationOnce(async (copy) => {
        await f.assign(copy);
        assigned.resolve();
        return finish.promise;
      });
      const request = f.controller.handle("extend", f.ctx);
      await assigned.promise;
      if (key === "metadata" || key === "cloneMismatch")
        f.state.current = {
          ...f.state.current!,
          [key === "metadata" ? "baseUrl" : "maxTokens"]:
            key === "metadata" ? "https://other.invalid" : 100,
        };
      else f.state[key] = "changed";
      finish.resolve(true);
      await request;
      expect(f.api.setModel.mock.calls[0][0].contextWindow).toBe(922_000);
      expect(f.catalog.contextWindow).toBe(272_000);
      expect(f.state.thinking).toBe("off");
      expect(f.api.setThinkingLevel).not.toHaveBeenCalled();
      expect(f.api.appendEntry).not.toHaveBeenCalled();
      expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("uncertain"), "warning");
      f.state.current = f.catalog;
      await f.controller.reconcile(f.ctx);
      await f.controller.modelSelected(f.ctx);
      await f.controller.restore(f.ctx);
      expect(f.api.setModel).toHaveBeenCalledTimes(1);
      await f.controller.handle("extend", f.ctx);
      expect(f.state.current?.contextWindow).toBe(922_000);
      expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["shutdown", "restore"] as const)(
    "invalidates pending setModel on %s without reading stale getters",
    async (event) => {
      const f = fixture();
      const started = deferred<Model<Api>>();
      const finish = deferred<void>();
      f.api.setModel.mockImplementationOnce(async (copy) => {
        started.resolve(copy);
        await finish.promise;
        // An SDK selection can still assign after local cleanup.
        f.state.current = copy;
        f.state.thinking = "off";
        return true;
      });
      const request = f.controller.handle("extend", f.ctx);
      const copy = await started.promise;
      const original = structuredClone(copy);
      const live = f.replaceRoot();
      if (event === "shutdown") f.controller.shutdown(live);
      else await f.controller.restore(live);
      expect(f.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("cannot be cancelled"),
        "warning",
      );
      f.notify.mockClear();
      finish.resolve();
      await request;
      expect(copy).toEqual(original);
      expect(f.state.staleReads).toBe(0);
      expect(f.state.current?.contextWindow).toBe(922_000);
      expect(f.api.appendEntry).not.toHaveBeenCalled();
      expect(f.api.setThinkingLevel).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
    },
  );

  it.each(["extend", "restore"])(
    "does not repair a throw-after-assignment on %s",
    async (action) => {
      const f = fixture();
      if (action === "restore") await f.controller.handle("extend", f.ctx);
      const previous = f.state.current!;
      const original = structuredClone(previous);
      const records = f.api.appendEntry.mock.calls.length;
      f.api.setThinkingLevel.mockClear();
      f.api.setModel.mockImplementationOnce(async (copy) => {
        await f.assign(copy);
        throw new Error("model hook failed after assignment");
      });
      await f.controller.handle(action, f.ctx);
      expect(f.state.current?.contextWindow).toBe(action === "extend" ? 922_000 : 272_000);
      expect(previous).toEqual(original);
      expect(f.state.thinking).toBe("off");
      expect(f.api.setThinkingLevel).not.toHaveBeenCalled();
      expect(f.api.appendEntry).toHaveBeenCalledTimes(records);
      expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining("uncertain"), "warning");
      await f.controller.reconcile(f.ctx);
      f.controller.shutdown();
      expect(previous).toEqual(original);
    },
  );

  it("does not rewrite a pending copy or external selection during authentication", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    const oldCopy = f.state.current!;
    const started = deferred<Model<Api>>();
    const finish = deferred<void>();
    f.api.setModel.mockImplementationOnce(async (copy) => {
      started.resolve(copy);
      await finish.promise;
      await f.assign(copy);
      return true;
    });
    const request = f.controller.handle("restore", f.ctx);
    const pending = await started.promise;
    const originalPending = structuredClone(pending);
    const external = model("other", "another-provider");
    const originalExternal = structuredClone(external);
    await f.assign(external);
    expect(pending).toEqual(originalPending);
    finish.resolve();
    await request;
    expect(f.state.current).toEqual(originalPending);
    expect(external).toEqual(originalExternal);
    expect(oldCopy.contextWindow).toBe(922_000);
    expect(f.state.thinking).toBe("off");
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledWith(
      expect.stringContaining("cannot be cancelled"),
      "warning",
    );
    f.state.current = f.catalog;
    await f.controller.reconcile(f.ctx);
    expect(f.api.setModel).toHaveBeenCalledTimes(2);
  });

  it("replays the selected model's ordinary branch preference on a provider/ID event", async () => {
    const f = fixture();
    f.state.branch = [entry(preference(true, "gpt-6-astra"))];
    await f.controller.restore(f.ctx);
    const astra = model("gpt-6-astra");
    f.state.catalog = astra;
    await f.assign(astra);
    expect(f.state.current?.id).toBe("gpt-6-astra");
    expect(f.state.current?.contextWindow).toBe(922_000);
    expect(astra.contextWindow).toBe(272_000);
    expect(f.api.setModel).toHaveBeenCalledTimes(1);
    expect(f.api.appendEntry).not.toHaveBeenCalled();
    expect(f.state.thinking).toBe("off");
  });

  it("replays a saved choice after same-ID catalog selection via the next idle hook", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    const oldCopy = f.state.current!;
    await f.assign(f.catalog); // no model_select
    expect(f.state.current?.contextWindow).toBe(272_000);
    await f.controller.reconcile(f.ctx);
    expect(f.state.current?.contextWindow).toBe(922_000);
    expect(oldCopy.contextWindow).toBe(922_000);
    expect(f.catalog.contextWindow).toBe(272_000);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("restores an extended selection with a fresh controller using catalog baseline", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    f.controller.shutdown();
    const controller = new ContextController(f.api, "personal:context");
    await controller.restore(f.ctx);
    expect(f.state.current?.contextWindow).toBe(922_000);
    await controller.handle("restore", f.ctx);
    expect(f.api.setModel.mock.lastCall?.[0].contextWindow).toBe(272_000);
    expect(f.state.current?.contextWindow).toBe(272_000);
    expect(f.api.appendEntry).toHaveBeenLastCalledWith(CONTEXT_ENTRY, preference(false));
  });

  it.each([300_000, 1_000_000])(
    "honors catalog override %s rather than a guessed default",
    async (window) => {
      const f = fixture({ ...model(), contextWindow: window });
      await f.controller.handle("extend", f.ctx);
      expect(f.state.current?.contextWindow).toBe(Math.max(window, 922_000));
      await f.controller.handle("restore", f.ctx);
      expect(f.state.current?.contextWindow).toBe(window);
      if (window >= 922_000) {
        expect(f.confirm).not.toHaveBeenCalled();
        expect(f.notify).toHaveBeenLastCalledWith(
          expect.stringContaining("no smaller default is known"),
          "info",
        );
      }
    },
  );

  it.each([
    undefined,
    { ...model(), id: "other" },
    { ...model(), provider: "other" },
    { ...model(), api: "openai-responses" },
    { ...model(), baseUrl: "https://other.invalid" },
    ...[0, -1, NaN, Infinity].map((contextWindow) => ({ ...model(), contextWindow })),
  ])("refuses missing/incompatible/invalid catalog baseline %j", async (catalog) => {
    const f = fixture();
    f.state.current = { ...f.catalog, contextWindow: 922_000 };
    f.state.catalog = catalog;
    await f.controller.handle("restore", f.ctx);
    await f.controller.handle("extend", f.ctx);
    await f.controller.reconcile(f.ctx);
    expect(f.api.setModel).not.toHaveBeenCalled();
    expect(f.api.appendEntry).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("baseline is unknown"),
      "warning",
    );
    await f.controller.handle("", f.ctx);
    expect(f.notify).toHaveBeenLastCalledWith(expect.stringMatching(/Standard +unknown/), "info");
  });
});
