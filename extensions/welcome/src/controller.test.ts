import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { WelcomeController } from "./controller.ts";
import { ENTRY_TYPE, type WelcomeAPI, type WelcomeData, type WelcomeHost } from "./types.ts";

const welcomeData: WelcomeData = Object.freeze({
  directory: "~/work/project",
  branch: "main",
  session: "Planning",
  model: "local / test",
  context: "AGENTS.md",
  skills: "0 found",
  prompts: "0 found",
  tools: "1 active / 2 available",
});

const savedTree: SessionEntry = {
  type: "custom",
  customType: ENTRY_TYPE,
  data: welcomeData,
  id: "tree",
  parentId: null,
  timestamp: "2026-01-01T00:00:00Z",
};
const message: SessionEntry = {
  type: "message",
  id: "message",
  parentId: null,
  timestamp: "2026-01-01T00:00:01Z",
  message: { role: "user", content: "Continue", timestamp: 1 },
};

// These are just the ports the controller uses, not a Pi runtime or a Git repository.
function fixture() {
  const state = {
    sessionId: "fresh-session",
    leafId: null as string | null,
    cwd: "/virtual/project",
    entries: [] as SessionEntry[],
    branch: [] as SessionEntry[],
    stale: false,
  };
  function live() {
    if (state.stale) throw new Error("event context expired");
  }
  const pi = {
    appendEntry: vi.fn<WelcomeAPI["appendEntry"]>(),
    getCommands: vi.fn<WelcomeAPI["getCommands"]>(() => []),
    getActiveTools: vi.fn<WelcomeAPI["getActiveTools"]>(() => []),
    getAllTools: vi.fn<WelcomeAPI["getAllTools"]>(() => []),
  } satisfies WelcomeAPI;
  const ctx: WelcomeHost = {
    mode: "tui",
    get cwd() {
      live();
      return state.cwd;
    },
    get model() {
      live();
      return undefined;
    },
    get thinkingLevel() {
      live();
      return "off" as const;
    },
    get sessionManager() {
      live();
      return sessionManager;
    },
  };
  const sessionManager = {
    getSessionId: vi.fn(() => {
      live();
      return state.sessionId;
    }),
    getSessionName: vi.fn(() => {
      live();
      return "Planning";
    }),
    getLeafId: vi.fn(() => {
      live();
      return state.leafId;
    }),
    getEntries: vi.fn(() => {
      live();
      return state.entries;
    }),
    getBranch: vi.fn(() => {
      live();
      return state.branch;
    }),
  } satisfies WelcomeHost["sessionManager"];
  const collect = vi.fn<
    (pi: WelcomeAPI, ctx: WelcomeHost, signal: AbortSignal) => Promise<WelcomeData>
  >(async () => welcomeData);
  const controller = new WelcomeController(pi, collect);
  return { state, pi, ctx, collect, controller };
}

function pendingData() {
  let resolve!: (data: WelcomeData) => void;
  const promise = new Promise<WelcomeData>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("startup persistence", () => {
  it("appends one auto tree for a fresh TUI session, including repeated bindings", async () => {
    const { controller, ctx, collect, pi } = fixture();
    await controller.sessionStarted(ctx);
    await controller.sessionStarted(ctx);
    expect(collect).toHaveBeenCalledExactlyOnceWith(pi, ctx, expect.any(AbortSignal));
    expect(pi.appendEntry).toHaveBeenCalledExactlyOnceWith("eleith-startup-tree", {
      ...welcomeData,
      treeSize: "auto",
    });
    expect(welcomeData).not.toHaveProperty("treeSize");
  });

  it("finds a saved startup anywhere in the full entries, even off the active branch", async () => {
    const { controller, state, ctx, collect, pi } = fixture();
    state.entries = [savedTree];
    state.branch = [];
    await controller.sessionStarted(ctx);
    // Switching to a branch without the saved tree does not make this a fresh session.
    state.entries = [];
    await controller.sessionStarted(ctx);
    expect(collect).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("does not welcome a resumed session whose active branch contains a message", async () => {
    const { controller, state, ctx, collect, pi } = fixture();
    state.entries = [message];
    state.branch = [message];
    await controller.sessionStarted(ctx);
    await controller.sessionStarted(ctx);
    expect(collect).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("a newly loaded controller also skips the persisted entry", async () => {
    const { controller, state, ctx, collect, pi } = fixture();
    await controller.sessionStarted(ctx);
    state.entries = [savedTree];
    controller.dispose();
    const reloaded = new WelcomeController(pi, collect);
    await reloaded.sessionStarted(ctx);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("does not mistake off-branch messages or unrelated custom entries for a startup", async () => {
    const { controller, state, ctx, pi } = fixture();
    state.entries = [message, { ...savedTree, customType: "another-extension" }];
    state.branch = [];
    await controller.sessionStarted(ctx);
    expect(pi.appendEntry).toHaveBeenCalledExactlyOnceWith(ENTRY_TYPE, {
      ...welcomeData,
      treeSize: "auto",
    });
  });

  it("allows a fresh session after the previous session was welcomed", async () => {
    const { controller, state, ctx, collect, pi } = fixture();
    await controller.sessionStarted(ctx);
    state.sessionId = "next-session";
    await controller.sessionStarted(ctx);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
  });
});

describe("explicit show", () => {
  it.each(["auto", "large", "small", "tiny"] as const)(
    "allows repeated %s cards even on a resumed branch with a saved startup",
    async (size) => {
      const { controller, state, ctx, collect, pi } = fixture();
      state.entries = [savedTree, message];
      state.branch = [message];
      await controller.show(ctx, size);
      await controller.show(ctx, size);
      expect(collect).toHaveBeenCalledTimes(2);
      expect(pi.appendEntry.mock.calls).toEqual([
        [ENTRY_TYPE, { ...welcomeData, treeSize: size }],
        [ENTRY_TYPE, { ...welcomeData, treeSize: size }],
      ]);
    },
  );

  it("defaults an explicit show to auto", async () => {
    const { controller, ctx, pi } = fixture();
    await controller.show(ctx);
    expect(pi.appendEntry).toHaveBeenCalledExactlyOnceWith(ENTRY_TYPE, {
      ...welcomeData,
      treeSize: "auto",
    });
  });

  it.each(["rpc", "json", "print"] as const)(
    "never collects or appends in %s mode",
    async (mode) => {
      const { controller, ctx, collect, pi } = fixture();
      ctx.mode = mode;
      await controller.sessionStarted(ctx);
      await controller.show(ctx, "large");
      expect(collect).not.toHaveBeenCalled();
      expect(pi.appendEntry).not.toHaveBeenCalled();
    },
  );
});

describe("pending collections", () => {
  it("dispose aborts collection, and late data needs no expired context getters", async () => {
    const { controller, state, ctx, collect, pi } = fixture();
    const delayed = pendingData();
    collect.mockReturnValueOnce(delayed.promise);
    const startup = controller.sessionStarted(ctx);
    const signal = collect.mock.calls[0][2];
    expect(signal.aborted).toBe(false);
    controller.dispose();
    expect(signal.aborted).toBe(true);
    state.stale = true;
    delayed.resolve(welcomeData);
    await expect(startup).resolves.toBeUndefined();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("does not start any collection after disposal", async () => {
    const { controller, ctx, collect, pi } = fixture();
    controller.dispose();
    await controller.sessionStarted(ctx);
    await controller.show(ctx);
    expect(collect).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("a new request aborts the old one before its late result can append or read context", async () => {
    const old = fixture();
    const delayed = pendingData();
    old.collect.mockReturnValueOnce(delayed.promise);
    const first = old.controller.show(old.ctx, "large");
    const oldSignal = old.collect.mock.calls[0][2];
    const next = fixture();
    await old.controller.show(next.ctx, "tiny");
    expect(oldSignal.aborted).toBe(true);
    old.state.stale = true;
    delayed.resolve(welcomeData);
    await expect(first).resolves.toBeUndefined();
    expect(old.pi.appendEntry).toHaveBeenCalledExactlyOnceWith(ENTRY_TYPE, {
      ...welcomeData,
      treeSize: "tiny",
    });
  });

  it("a duplicate startup binding cancels the in-flight collection and only its replacement appends", async () => {
    const { controller, ctx, collect, pi } = fixture();
    const delayed = pendingData();
    collect.mockReturnValueOnce(delayed.promise);
    const first = controller.sessionStarted(ctx);
    const oldSignal = collect.mock.calls[0][2];
    await controller.sessionStarted(ctx);
    expect(oldSignal.aborted).toBe(true);
    delayed.resolve(welcomeData);
    await first;
    expect(collect).toHaveBeenCalledTimes(2);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    await controller.sessionStarted(ctx);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it.each(["sessionId", "cwd"] as const)("discards late data when %s changed", async (field) => {
    const { controller, state, ctx, collect, pi } = fixture();
    const delayed = pendingData();
    collect.mockReturnValueOnce(delayed.promise);
    const show = controller.show(ctx);
    state[field] = "changed";
    delayed.resolve(welcomeData);
    await show;
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("does not insert startup mid-turn if a branch message appears while Git is pending", async () => {
    const { controller, state, ctx, collect, pi } = fixture();
    const delayed = pendingData();
    collect.mockReturnValueOnce(delayed.promise);
    const startup = controller.sessionStarted(ctx);
    // Keep the leaf unchanged to exercise the message check independently.
    state.branch = [message];
    delayed.resolve(welcomeData);
    await startup;
    await controller.sessionStarted(ctx);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("discards startup if the leaf changes while collecting", async () => {
    const { controller, state, ctx, collect, pi } = fixture();
    const delayed = pendingData();
    collect.mockReturnValueOnce(delayed.promise);
    const startup = controller.sessionStarted(ctx);
    state.leafId = "another-leaf";
    delayed.resolve(welcomeData);
    await startup;
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("discards a manual card if navigation changes the leaf before its listener runs", async () => {
    const { controller, state, ctx, collect, pi } = fixture();
    const delayed = pendingData();
    collect.mockReturnValueOnce(delayed.promise);
    const show = controller.show(ctx, "tiny");
    state.leafId = "selected-branch";
    // Earlier session_tree listeners can await I/O before sessionChanged gets called.
    expect(collect.mock.calls[0][2].aborted).toBe(false);
    delayed.resolve(welcomeData);
    await show;
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("discards startup if another binding persists a tree during collection", async () => {
    const { controller, state, ctx, collect, pi } = fixture();
    const delayed = pendingData();
    collect.mockReturnValueOnce(delayed.promise);
    const startup = controller.sessionStarted(ctx);
    state.entries = [savedTree];
    delayed.resolve(welcomeData);
    await startup;
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("the earlier request's finally cannot clear the next pending request", async () => {
    const { controller, ctx, collect, pi } = fixture();
    const earlier = pendingData();
    const next = pendingData();
    collect.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(next.promise);
    const first = controller.show(ctx, "large");
    const second = controller.show(ctx, "small");
    const nextSignal = collect.mock.calls[1][2];
    expect(collect.mock.calls[0][2].aborted).toBe(true);
    earlier.resolve(welcomeData);
    await first;
    expect(nextSignal.aborted).toBe(false);
    controller.dispose();
    expect(nextSignal.aborted).toBe(true);
    next.resolve(welcomeData);
    await second;
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });
});
