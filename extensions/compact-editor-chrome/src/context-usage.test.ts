import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ContextUsageCache } from "./context-usage.ts";

type UsageContext = Parameters<ContextUsageCache["get"]>[0];

function fixture() {
  const manager = SessionManager.inMemory("/unused");
  const getContextUsage = vi.fn<ExtensionContext["getContextUsage"]>(() => ({
    tokens: 12_000,
    contextWindow: 128_000,
    percent: 9.375,
  }));
  const ctx: UsageContext = {
    model: { api: "test", contextWindow: 128_000 } as NonNullable<ExtensionContext["model"]>,
    sessionManager: manager,
    getContextUsage,
  };
  return { cache: new ContextUsageCache(), ctx, manager, getContextUsage };
}

const userMessage = { role: "user" as const, content: "hello", timestamp: 1000 };

describe("ContextUsageCache", () => {
  it("reuses one snapshot across redraws without scanning or copying history", () => {
    const f = fixture();
    const first = f.cache.get(f.ctx);
    for (const method of ["getEntries", "getBranch", "buildSessionProjection"] as const) {
      vi.spyOn(f.manager, method).mockImplementation(() => {
        throw new Error("History access on a cache hit");
      });
    }
    for (let redraw = 0; redraw < 100; redraw++) {
      expect(f.cache.get({ ...f.ctx })).toBe(first);
    }
    expect(f.getContextUsage).toHaveBeenCalledOnce();
  });

  it.each([
    ["message", (manager: SessionManager, _entry: string) => manager.appendMessage(userMessage)],
    [
      "compaction",
      (manager: SessionManager, entry: string) =>
        manager.appendCompaction("summary", entry, 12_000),
    ],
    [
      "context edit",
      (manager: SessionManager, entry: string) =>
        manager.appendContextEdit(entry, { content: "edited" }),
    ],
  ] as const)("refreshes after a real SDK %s changes the leaf", (_name, change) => {
    const f = fixture();
    const entry = f.manager.appendMessage(userMessage);
    f.cache.get(f.ctx);
    change(f.manager, entry);
    const updated = { tokens: null, contextWindow: 128_000, percent: null };
    f.getContextUsage.mockReturnValue(updated);
    expect(f.cache.get(f.ctx)).toBe(updated);
    expect(f.cache.get(f.ctx)).toBe(updated);
    expect(f.getContextUsage).toHaveBeenCalledTimes(2);
  });

  it("refreshes on branch navigation, including return to a previously cached leaf", () => {
    const f = fixture();
    const first = f.manager.appendMessage(userMessage);
    const second = f.manager.appendMessage(userMessage);
    f.cache.get(f.ctx);
    f.manager.branch(first);
    f.cache.get(f.ctx);
    f.manager.branch(second);
    f.cache.get(f.ctx);
    expect(f.getContextUsage).toHaveBeenCalledTimes(3);
  });

  it("refreshes across empty sessions even though their leaf IDs are both null", () => {
    const f = fixture();
    f.cache.get(f.ctx);
    f.ctx.sessionManager = SessionManager.inMemory("/unused");
    expect(f.ctx.sessionManager.getLeafId()).toBeNull();
    f.cache.get(f.ctx);
    expect(f.getContextUsage).toHaveBeenCalledTimes(2);
  });

  it("refreshes on model replacement and an in-place window change", () => {
    const f = fixture();
    f.cache.get(f.ctx);
    f.ctx.model = { ...f.ctx.model! };
    f.cache.get(f.ctx);
    f.ctx.model.contextWindow = 1_000_000;
    f.cache.get(f.ctx);
    expect(f.getContextUsage).toHaveBeenCalledTimes(3);
  });

  it("caches unavailable usage but refreshes when a model becomes available", () => {
    const f = fixture();
    const model = f.ctx.model;
    f.ctx.model = undefined;
    f.getContextUsage.mockReturnValue(undefined);
    expect(f.cache.get(f.ctx)).toBeUndefined();
    expect(f.cache.get(f.ctx)).toBeUndefined();
    expect(f.getContextUsage).toHaveBeenCalledOnce();
    f.ctx.model = model;
    const available = { tokens: 0, contextWindow: 128_000, percent: 0 };
    f.getContextUsage.mockReturnValue(available);
    expect(f.cache.get(f.ctx)).toBe(available);
    expect(f.getContextUsage).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed lookup", () => {
    const f = fixture();
    f.getContextUsage.mockImplementationOnce(() => {
      throw new Error("Transient lookup failure");
    });
    expect(() => f.cache.get(f.ctx)).toThrow("Transient lookup failure");
    expect(f.cache.get(f.ctx)?.tokens).toBe(12_000);
    expect(f.getContextUsage).toHaveBeenCalledTimes(2);
  });

  it("leaves virtual-model usage live and discards the previous cached selection", () => {
    const f = fixture();
    const model = f.ctx.model;
    f.cache.get(f.ctx);
    f.ctx.model = { ...model!, api: "pi-virtual" };
    f.cache.get(f.ctx);
    const routed = { tokens: 12_000, contextWindow: 1_000_000, percent: 1.2 };
    f.getContextUsage.mockReturnValue(routed);
    expect(f.cache.get(f.ctx)).toBe(routed);
    f.ctx.model = model;
    f.cache.get(f.ctx);
    expect(f.getContextUsage).toHaveBeenCalledTimes(4);
  });
});
