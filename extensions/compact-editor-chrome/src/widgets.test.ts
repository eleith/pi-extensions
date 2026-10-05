import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ChromeSnapshot, ThemeLike } from "./types.ts";
import { BOTTOM_WIDGET, EmptyFooter, PromptStatusWidget, TOP_WIDGET } from "./widgets.ts";

function themeFixture(ansi = false) {
  const fg = vi.fn<ThemeLike["fg"]>((_color, text) => (ansi ? `\x1b[36m${text}\x1b[39m` : text));
  const bold = vi.fn<ThemeLike["bold"]>((text) => (ansi ? `\x1b[1m${text}\x1b[22m` : text));
  return { theme: { fg, bold } as unknown as Theme, fg, bold };
}

function snapshotFixture() {
  // These are the only root-context inputs consumed by the formatters.
  const getContextUsage = vi.fn<ExtensionContext["getContextUsage"]>(() => ({
    tokens: 12_000,
    contextWindow: 128_000,
    percent: 9.375,
  }));
  const ctx = {
    cwd: "/work/项目🚀",
    model: { name: "智🚀 e\u0301 GPT-very-long-model", contextWindow: 128_000 },
    thinkingLevel: "high",
    getContextUsage,
  } as unknown as ExtensionContext;
  const statuses = new Map([
    ["one", "\x1b[31m准备🚀\x1b[0m"],
    ["two", "e\u0301 queued"],
  ]);
  const getExtensionStatuses = vi.fn(() => statuses);
  const getGitBranch = vi.fn((): string | null => "主题🚀");
  const footerData = {
    getExtensionStatuses,
    getGitBranch,
  } as unknown as ReadonlyFooterDataProvider;
  const snapshot: ChromeSnapshot = {
    ctx,
    footerData,
    gitStatus: { staged: 1, unstaged: 2, untracked: 3 },
  };
  return { snapshot, ctx, statuses, getContextUsage, getExtensionStatuses, getGitBranch };
}

function widgetFixture(placement: "top" | "bottom", ansi = false) {
  const data = snapshotFixture();
  const style = themeFixture(ansi);
  const getSnapshot = vi.fn((): ChromeSnapshot | undefined => data.snapshot);
  const onRender = vi.fn<() => void>();
  const widget = new PromptStatusWidget(getSnapshot, onRender, placement, style.theme);
  return { ...data, ...style, getSnapshot, onRender, widget };
}

const widths = [1, 5, 20, 40, 80, 120] as const;

describe("widget IDs and empty footer", () => {
  it("exports the current extension-owned widget IDs", () => {
    expect(TOP_WIDGET).toBe("eleith-prompt-status-top");
    expect(BOTTOM_WIDGET).toBe("eleith-prompt-status-bottom");
  });

  it("renders no footer rows and tolerates invalidation/default disposal", () => {
    const footer = new EmptyFooter();
    expect(footer.render()).toEqual([]);
    footer.invalidate();
    footer.dispose();
    expect(footer.render()).toEqual([]);
  });

  it("delegates each disposal to its callback (listener idempotency belongs to the controller)", () => {
    const onDispose = vi.fn<() => void>();
    const footer = new EmptyFooter(onDispose);
    footer.invalidate();
    expect(onDispose).not.toHaveBeenCalled();
    footer.dispose();
    expect(onDispose).toHaveBeenCalledOnce();
    footer.dispose();
    expect(onDispose).toHaveBeenCalledTimes(2);
  });
});

for (const ansi of [false, true]) {
  describe(`${ansi ? "ANSI" : "plain"} themed Unicode widgets`, () => {
    for (const placement of ["top", "bottom"] as const) {
      it.each(widths)(`${placement} respects visible width %i`, (width) => {
        const f = widgetFixture(placement, ansi);
        const lines = f.widget.render(width);
        expect(lines.length).toBe(placement === "top" || width === 120 ? 1 : 2);
        for (const line of lines) {
          expect(visibleWidth(line)).toBeGreaterThan(0);
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          expect(stripTerminalSequences(line)).not.toContain("\x1b");
          if (placement === "top") expect(visibleWidth(line)).toBe(width);
        }
        expect(f.onRender).toHaveBeenCalledOnce();
        expect(f.getSnapshot).toHaveBeenCalledOnce();
        expect(f.fg).toHaveBeenCalledWith("muted", "›");
        if (placement === "top") {
          expect(f.getContextUsage).toHaveBeenCalledOnce();
          expect(f.getExtensionStatuses).not.toHaveBeenCalled();
          expect(f.getGitBranch).not.toHaveBeenCalled();
        } else {
          expect(f.getContextUsage).not.toHaveBeenCalled();
          expect(f.getExtensionStatuses).toHaveBeenCalledOnce();
          expect(f.getGitBranch).toHaveBeenCalledOnce();
        }
      });
    }
  });
}

describe("PromptStatusWidget top layout", () => {
  it("right-aligns the full Unicode status with padding based on visible, not ANSI, width", () => {
    const f = widgetFixture("top", true);
    const line = f.widget.render(120)[0]!;
    const content = " 智🚀 e\u0301 GPT-very-long-model › Thinking: High › Context: 12k/128k ";
    expect(stripTerminalSequences(line)).toBe(" ".repeat(120 - visibleWidth(content)) + content);
    expect(line).toContain("\x1b[36m");
    expect(line).toContain("\x1b[1m");
  });

  it("uses compact thinking/context status before truncating at medium width", () => {
    const f = widgetFixture("top");
    const content = " Thinking: High › Context: 12k/128k ";
    expect(f.widget.render(40)).toEqual([" ".repeat(40 - visibleWidth(content)) + content]);
  });

  it("drops model and thinking before fitting context-only status", () => {
    const f = widgetFixture("top");
    const content = " Context: 12k/128k ";
    expect(f.widget.render(20)).toEqual([" ".repeat(20 - visibleWidth(content)) + content]);
  });

  it.each([1, 5] as const)("trims context-only status at width %i with an ellipsis", (width) => {
    const f = widgetFixture("top", true);
    expect(stripTerminalSequences(f.widget.render(width)[0]!)).toBe(width === 1 ? "…" : " Con…");
  });
});

describe("PromptStatusWidget bottom layout", () => {
  it("keeps status, project, branch and changes in one left-aligned row when they fit", () => {
    const f = widgetFixture("bottom", true);
    expect(f.widget.render(120).map(stripTerminalSequences)).toEqual([
      " 准备🚀 › e\u0301 queued › 项目🚀 › Git: 主题🚀 › 1 staged change › 2 unstaged changes › 3 untracked files ",
    ]);
    expect(f.fg).toHaveBeenCalledWith("dim", expect.any(String));
  });

  it("moves Git onto a second row before truncation, without right padding", () => {
    const f = widgetFixture("bottom");
    expect(f.widget.render(40).map(stripTerminalSequences)).toEqual([
      " 准备🚀 › e\u0301 queued › 项目🚀 ",
      " Git: 主题🚀 › 1 staged change › 2 unst…",
    ]);
    expect(visibleWidth(f.widget.render(40)[0]!)).toBeLessThan(40);
  });

  it("renders the project alone when no footer data exists", () => {
    const f = widgetFixture("bottom");
    f.getSnapshot.mockReturnValue({ ...f.snapshot, footerData: undefined });
    expect(f.widget.render(80)).toEqual([" 项目🚀 "]);
    expect(f.getExtensionStatuses).not.toHaveBeenCalled();
    expect(f.getGitBranch).not.toHaveBeenCalled();
  });

  it("does not produce a separate Git row without a branch, even if Git counts exist", () => {
    const f = widgetFixture("bottom");
    f.getGitBranch.mockReturnValue(null);
    expect(f.widget.render(80)).toEqual([" 准备🚀 › e\u0301 queued › 项目🚀 "]);
  });

  it("renders a branch without counts when polling has no snapshot", () => {
    const f = widgetFixture("bottom");
    f.getSnapshot.mockReturnValue({ ...f.snapshot, gitStatus: null });
    expect(f.widget.render(80)).toEqual([" 准备🚀 › e\u0301 queued › 项目🚀 › Git: 主题🚀 "]);
  });

  it("renders clean Git and empty statuses without blank sections", () => {
    const f = widgetFixture("bottom");
    f.statuses.clear();
    f.getSnapshot.mockReturnValue({
      ...f.snapshot,
      gitStatus: { staged: 0, unstaged: 0, untracked: 0 },
    });
    expect(f.widget.render(80)).toEqual([" 项目🚀 › Git: 主题🚀 › clean "]);
  });
});

describe("PromptStatusWidget render lifetimes", () => {
  it.each(["top", "bottom"] as const)(
    "%s skips callbacks and context access at non-positive widths",
    (placement) => {
      const f = widgetFixture(placement);
      f.getSnapshot.mockImplementation(() => {
        throw new Error("snapshot must not be read");
      });
      expect(f.widget.render(0)).toEqual([]);
      expect(f.widget.render(-1)).toEqual([]);
      expect(f.onRender).not.toHaveBeenCalled();
      expect(f.getSnapshot).not.toHaveBeenCalled();
      expect(f.fg).not.toHaveBeenCalled();
    },
  );

  it.each(["top", "bottom"] as const)(
    "%s returns [] for an absent snapshot without reading root context/theme/footer",
    (placement) => {
      const f = widgetFixture(placement);
      f.getSnapshot.mockReturnValue(undefined);
      Object.defineProperty(f.snapshot, "ctx", {
        get() {
          throw new Error("expired root context");
        },
      });
      expect(f.widget.render(80)).toEqual([]);
      expect(f.onRender).toHaveBeenCalledOnce();
      expect(f.getSnapshot).toHaveBeenCalledOnce();
      expect(f.fg).not.toHaveBeenCalled();
      expect(f.getContextUsage).not.toHaveBeenCalled();
      expect(f.getExtensionStatuses).not.toHaveBeenCalled();
      expect(f.getGitBranch).not.toHaveBeenCalled();
    },
  );

  it("runs the refresh callback before retrieving the snapshot on every render", () => {
    const f = widgetFixture("bottom");
    f.getSnapshot.mockReturnValue(undefined);
    f.onRender.mockImplementation(() => f.getSnapshot.mockReturnValue(f.snapshot));
    expect(f.widget.render(80)).not.toEqual([]);
    expect(f.onRender.mock.invocationCallOrder[0]).toBeLessThan(
      f.getSnapshot.mock.invocationCallOrder[0]!,
    );
    f.widget.render(80);
    expect(f.onRender).toHaveBeenCalledTimes(2);
    expect(f.getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("invalidation is a no-op, and render reads the latest snapshot instead of caching it", () => {
    const f = widgetFixture("bottom");
    f.widget.invalidate();
    expect(f.onRender).not.toHaveBeenCalled();
    expect(f.getSnapshot).not.toHaveBeenCalled();
    f.widget.render(120);
    f.getSnapshot.mockReturnValue({
      ...f.snapshot,
      ctx: { cwd: "/work/new-project" } as ExtensionContext,
      footerData: undefined,
    });
    expect(f.widget.render(120)).toEqual([" new-project "]);
    f.getSnapshot.mockReturnValue(undefined);
    expect(f.widget.render(120)).toEqual([]);
  });
});
