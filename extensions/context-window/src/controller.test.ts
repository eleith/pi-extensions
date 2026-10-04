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

// Only the controller's ports: assignment emits modelSelected and resets thinking,
// as Pi does. No registry, authentication implementation, or provider is involved.
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
    state.current = copy;
    state.thinking = "off";
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
  it("extends a private bounded copy, preserving catalog metadata and thinking", async () => {
    const f = fixture();
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
  });

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

  it("confirms restore and releases the old copy without another model switch", async () => {
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
    expect(extended.contextWindow).toBe(272_000);
    expect(f.catalog.contextWindow).toBe(272_000);
    expect(f.state.thinking).toBe("high");
    expect(f.api.appendEntry).toHaveBeenLastCalledWith(CONTEXT_ENTRY, preference(false));
    expect(f.api.setModel).toHaveBeenCalledTimes(2);

    f.controller.shutdown();
    expect(f.api.setModel).toHaveBeenCalledTimes(2);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(2);
  });

  it("shutdown restores owned metadata with no authentication or transcript writes", async () => {
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

    expect(owned.contextWindow).toBe(272_000);
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
    expect(f.state.current?.contextWindow).toBe(272_000);
    expect(f.api.setModel).toHaveBeenCalledTimes(1);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("restore aborts an old dialog and its finally cannot clear a newer request", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    const oldAnswer = deferred<boolean>();
    const newAnswer = deferred<boolean>();
    f.confirm.mockReturnValueOnce(oldAnswer.promise).mockReturnValueOnce(newAnswer.promise);
    const oldRequest = f.controller.handle("restore", f.ctx);
    const oldSignal = f.confirm.mock.calls[0][2]?.signal;
    f.state.branch = [];
    const newRequest = f.controller.restore(f.replaceRoot());
    const newSignal = f.confirm.mock.calls[1][2]?.signal;
    expect(oldSignal?.aborted).toBe(true);
    expect(newSignal?.aborted).toBe(false);
    oldAnswer.resolve(true);
    await oldRequest;
    expect(f.state.staleReads).toBe(0);

    await f.controller.handle("extend", f.ctx);
    expect(f.api.setModel).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Wait for the current run"),
      "warning",
    );
    newAnswer.resolve(true);
    await newRequest;
    expect(f.state.current?.contextWindow).toBe(272_000);
    expect(f.api.setModel).toHaveBeenCalledTimes(2);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("external modelSelected aborts a dialog, releases ownership, and clears the guard", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    const owned = f.state.current!;
    const answer = deferred<boolean>();
    f.confirm.mockReturnValueOnce(answer.promise);
    const oldRequest = f.controller.handle("restore", f.ctx);
    const signal = f.confirm.mock.calls[0][2]?.signal;
    const other = model("other", "other");
    f.state.current = other;
    await f.controller.modelSelected(f.replaceRoot());
    expect(signal?.aborted).toBe(true);
    expect(owned.contextWindow).toBe(272_000);
    f.notify.mockClear();
    answer.resolve(true);
    await oldRequest;
    expect(f.state.staleReads).toBe(0);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.state.current).toBe(other);

    f.state.current = f.catalog;
    await f.controller.handle("extend", f.ctx);
    expect(f.state.current?.contextWindow).toBe(922_000);
    expect(f.api.setModel).toHaveBeenCalledTimes(2);
  });

  it.each(["sessionId", "leafId"] as const)(
    "rejects a confirmation after %s changes",
    async (key) => {
      const f = fixture();
      await f.controller.handle("extend", f.ctx);
      const answer = deferred<boolean>();
      f.confirm.mockReturnValueOnce(answer.promise);
      const request = f.controller.handle("restore", f.ctx);
      f.state[key] = "changed";
      answer.resolve(true);
      await request;
      expect(f.api.setModel).toHaveBeenCalledTimes(1);
      expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
      expect(f.state.current?.contextWindow).toBe(922_000);
      expect(f.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("Try /personal:context again"),
        "warning",
      );
    },
  );

  it.each(["sessionId", "leafId"] as const)(
    "rejects a completed setModel after %s changes",
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
      f.state[key] = "changed";
      finish.resolve(true);
      await request;
      expect(f.state.current?.contextWindow).toBe(272_000);
      expect(f.catalog.contextWindow).toBe(272_000);
      expect(f.state.thinking).toBe("medium");
      expect(f.api.appendEntry).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();

      await f.controller.handle("extend", f.ctx);
      expect(f.state.current?.contextWindow).toBe(922_000);
      expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["shutdown", "restore"] as const)(
    "invalidates pending setModel on %s without reading stale getters",
    async (event) => {
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
      if (event === "shutdown") {
        f.controller.shutdown();
        f.expire();
      } else {
        await f.controller.restore(f.replaceRoot());
      }
      finish.resolve(true);
      await request;
      expect(f.state.staleReads).toBe(0);
      expect(f.state.current?.contextWindow).toBe(272_000);
      expect(f.api.appendEntry).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
      if (event === "restore") {
        await f.controller.handle("extend", f.ctx);
        expect(f.state.current?.contextWindow).toBe(922_000);
      }
    },
  );

  it("rolls back a post-assignment exception and restores thinking", async () => {
    const f = fixture();
    f.api.setModel.mockImplementationOnce(async (copy) => {
      await f.assign(copy);
      throw new Error("model hook failed after assignment");
    });
    await f.controller.handle("extend", f.ctx);
    expect(f.state.current).not.toBe(f.catalog);
    expect(f.state.current?.contextWindow).toBe(272_000);
    expect(f.state.thinking).toBe("medium");
    expect(f.api.appendEntry).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("/personal:context"),
      "error",
    );
    await f.controller.handle("extend", f.ctx);
    expect(f.state.current?.contextWindow).toBe(922_000);
  });

  it("failed restore retains ownership so shutdown can still restore the baseline", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    const oldCopy = f.state.current!;
    f.api.setModel.mockImplementationOnce(async (copy) => {
      await f.assign(copy);
      throw new Error("model hook failed after assignment");
    });
    await f.controller.handle("restore", f.ctx);
    expect(f.state.current?.contextWindow).toBe(922_000);
    expect(oldCopy.contextWindow).toBe(272_000);
    expect(f.state.thinking).toBe("medium");
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
    f.controller.shutdown();
    expect(f.state.current?.contextWindow).toBe(272_000);
    expect(f.catalog.contextWindow).toBe(272_000);
  });

  it("keeps an external selection and its thinking during setModel by changing only the pending private copy", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    const oldOwned = f.state.current!;
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
    const external = model("other", "another-provider");
    external.reasoning = false;
    external.contextWindow = 80_000;
    const original = structuredClone(external);
    f.state.current = external;
    f.state.thinking = "high";
    await f.controller.modelSelected(f.ctx);
    expect(pending).not.toBe(external);
    expect(pending).toEqual(original);
    finish.resolve();
    await request;

    expect(f.state.current).toBe(pending);
    expect(f.state.current).toEqual(original);
    expect(external).toEqual(original);
    expect(f.catalog.contextWindow).toBe(272_000);
    expect(oldOwned.contextWindow).toBe(272_000);
    expect(f.state.thinking).toBe("high");
    expect(f.api.setModel).toHaveBeenCalledTimes(2);
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
    f.controller.shutdown();
    expect(pending.contextWindow).toBe(80_000);
  });

  it("reconciles saved preferences after catalog replacement without mutating either catalog object", async () => {
    const f = fixture();
    await f.controller.handle("extend", f.ctx);
    const oldOwned = f.state.current!;
    const replacement = model();
    replacement.name = "Refreshed catalog entry";
    const original = structuredClone(replacement);
    f.state.current = replacement;
    await f.controller.modelSelected(f.ctx);

    expect(oldOwned.contextWindow).toBe(272_000);
    expect(f.state.current).not.toBe(replacement);
    expect(f.state.current).toEqual({ ...original, contextWindow: 922_000 });
    expect(replacement).toEqual(original);
    expect(f.catalog.contextWindow).toBe(272_000);
    expect(f.state.thinking).toBe("medium");
    expect(f.api.appendEntry).toHaveBeenCalledTimes(1);
    f.controller.shutdown();
    expect(f.state.current?.contextWindow).toBe(272_000);
    expect(replacement).toEqual(original);
  });
});
