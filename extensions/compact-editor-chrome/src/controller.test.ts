import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { CompactEditorChromeController } from "./controller.ts";
import { BOTTOM_WIDGET, TOP_WIDGET } from "./widgets.ts";

// Use the last (component factory) setWidget overload, just as controller.ts does.
type WidgetFactory = NonNullable<Parameters<ExtensionContext["ui"]["setWidget"]>[1]>;
type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
type GitFactory = NonNullable<ConstructorParameters<typeof CompactEditorChromeController>[0]>;

function uiFixture() {
  const setWidget = vi.fn<ExtensionContext["ui"]["setWidget"]>();
  const setFooter = vi.fn<ExtensionContext["ui"]["setFooter"]>();
  const setWorkingVisible = vi.fn<ExtensionContext["ui"]["setWorkingVisible"]>();
  const ui = { setWidget, setFooter, setWorkingVisible } as unknown as ExtensionContext["ui"];
  const ctx = {
    mode: "tui",
    cwd: "/work/first",
    ui,
    model: undefined,
    thinkingLevel: "off",
    getContextUsage: vi.fn(() => undefined),
    sessionManager: {
      getSessionId: vi.fn(() => "session"),
      getLeafId: vi.fn(() => null),
    },
  } as unknown as ExtensionContext;
  return { ctx, ui, setWidget, setFooter, setWorkingVisible };
}

function gitFixture() {
  const instances: Array<ReturnType<GitFactory> & { requestRender: () => void }> = [];
  const createGit = vi.fn<GitFactory>((requestRender) => {
    const poller = {
      requestRender,
      snapshot: vi.fn(() => ({ staged: 1, unstaged: 2, untracked: 3 })),
      refresh: vi.fn<(cwd: string) => void>(),
      invalidate: vi.fn<() => void>(),
      dispose: vi.fn<() => void>(),
    };
    instances.push(poller);
    return poller;
  });
  return { createGit, instances };
}

function footerFixture(statuses = new Map([["test", "ready"]])) {
  const callbacks: Array<() => void> = [];
  const unsubscribes: Array<ReturnType<typeof vi.fn<() => void>>> = [];
  const getExtensionStatuses = vi.fn(() => statuses);
  const onBranchChange = vi.fn((callback: () => void) => {
    callbacks.push(callback);
    const unsubscribe = vi.fn<() => void>();
    unsubscribes.push(unsubscribe);
    return unsubscribe;
  });
  const data = {
    getExtensionStatuses,
    onBranchChange,
    getGitBranch: vi.fn(() => "main"),
  } as unknown as ReadonlyFooterDataProvider;
  return { data, statuses, callbacks, unsubscribes, getExtensionStatuses, onBranchChange };
}

function renderFixture() {
  const requestRender = vi.fn<() => void>();
  const tui = { requestRender } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  return { tui, theme, requestRender };
}

function fixture() {
  const host = uiFixture();
  const git = gitFixture();
  const render = renderFixture();
  const footer = footerFixture();
  const controller = new CompactEditorChromeController(git.createGit);
  const footerFactory = () => host.setFooter.mock.calls.at(-1)![0]!;
  const widgetFactories = () =>
    host.setWidget.mock.calls.slice(-2).map((call) => call[1] as WidgetFactory);
  const mountFooter = () => footerFactory()(render.tui, render.theme, footer.data);
  const mountWidgets = () => widgetFactories().map((factory) => factory(render.tui, render.theme));
  return {
    ...host,
    ...git,
    ...render,
    footer,
    controller,
    footerFactory,
    widgetFactories,
    mountFooter,
    mountWidgets,
  };
}

function expectCleared(host: ReturnType<typeof uiFixture>) {
  expect(host.setWorkingVisible).toHaveBeenLastCalledWith(true);
  expect(host.setFooter).toHaveBeenLastCalledWith(undefined);
  expect(host.setWidget.mock.calls.slice(-2)).toEqual([
    [TOP_WIDGET, undefined],
    [BOTTOM_WIDGET, undefined, { placement: "belowEditor" }],
  ]);
}

describe("CompactEditorChromeController installation", () => {
  it("starts enabled and installs the current footer and editor widget IDs/placements", () => {
    const f = fixture();
    expect(f.controller.isEnabled()).toBe(true);
    f.controller.sessionStarted(f.ctx);
    expect(f.createGit).toHaveBeenCalledOnce();
    expect(f.setWorkingVisible).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.setFooter).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    expect(f.setWidget.mock.calls).toEqual([
      ["eleith-prompt-status-top", expect.any(Function)],
      ["eleith-prompt-status-bottom", expect.any(Function), { placement: "belowEditor" }],
    ]);
    const footer = f.mountFooter();
    expect(footer.render(80)).toEqual([]);
    expect(f.footer.onBranchChange).toHaveBeenCalledOnce();
    const widgets = f.mountWidgets();
    expect(widgets[0]!.render(80)[0]).toContain("Thinking: Off");
    expect(widgets[1]!.render(120)).toEqual([
      " ready › first › Git: main › 1 staged change › 2 unstaged changes › 3 untracked files ",
    ]);
    expect(f.instances[0]!.refresh).toHaveBeenCalledTimes(2);
    expect(f.instances[0]!.refresh).toHaveBeenLastCalledWith("/work/first");
  });

  it("hide disables installation, show re-enables it, and toggle uses the current enabled state", () => {
    const f = fixture();
    f.controller.hide(f.ctx);
    expect(f.controller.isEnabled()).toBe(false);
    f.controller.sessionStarted(f.ctx);
    expect(f.createGit).not.toHaveBeenCalled();
    expect(f.setFooter).not.toHaveBeenCalled();
    f.controller.show(f.ctx);
    expect(f.controller.isEnabled()).toBe(true);
    f.controller.toggle(f.ctx);
    expect(f.controller.isEnabled()).toBe(false);
    expectCleared(f);
    f.controller.toggle(f.ctx);
    expect(f.controller.isEnabled()).toBe(true);
    expect(f.createGit).toHaveBeenCalledTimes(2);
  });

  it.each(["rpc", "json", "print"] as const)(
    "never accesses UI or creates Git in %s mode",
    (mode) => {
      const git = gitFixture();
      const controller = new CompactEditorChromeController(git.createGit);
      const uiRead = vi.fn(() => {
        throw new Error("non-TUI UI read");
      });
      const ctx = {
        mode,
        get ui() {
          return uiRead();
        },
      } as unknown as ExtensionContext;
      controller.sessionStarted(ctx);
      controller.show(ctx);
      controller.toggle(ctx);
      controller.toggle(ctx);
      controller.updateContext(ctx);
      controller.requestRender();
      controller.hide(ctx);
      controller.dispose(ctx);
      expect(uiRead).not.toHaveBeenCalled();
      expect(git.createGit).not.toHaveBeenCalled();
    },
  );

  it("does not request rendering until a current factory supplies a TUI", () => {
    const f = fixture();
    f.controller.requestRender();
    f.controller.sessionStarted(f.ctx);
    f.instances[0]!.requestRender();
    expect(f.requestRender).not.toHaveBeenCalled();
    f.mountWidgets();
    f.instances[0]!.requestRender();
    expect(f.requestRender).toHaveBeenCalledOnce();
  });

  it.each(["show", "sessionStarted"] as const)(
    "repeated %s releases each poller and footer listener exactly once",
    (install) => {
      const f = fixture();
      f.controller[install](f.ctx);
      const firstFooter = f.mountFooter();
      f.controller[install](f.ctx);
      expect(f.instances[0]!.dispose).toHaveBeenCalledOnce();
      expect(f.footer.unsubscribes[0]).toHaveBeenCalledOnce();
      firstFooter.dispose?.();
      firstFooter.dispose?.();
      expect(f.footer.unsubscribes[0]).toHaveBeenCalledOnce();
      const secondFooter = f.mountFooter();
      f.controller.hide(f.ctx);
      secondFooter.dispose?.();
      f.controller.hide(f.ctx);
      expect(f.instances[1]!.dispose).toHaveBeenCalledOnce();
      expect(f.footer.unsubscribes[1]).toHaveBeenCalledOnce();
    },
  );
});

describe("CompactEditorChromeController callback lifetimes", () => {
  it.each(["hide", "dispose"] as const)(
    "%s cancels its poller and makes old widgets, factories and callbacks inert",
    (action) => {
      const f = fixture();
      f.controller.sessionStarted(f.ctx);
      const oldFooterFactory = f.footerFactory();
      const oldWidgetFactories = f.widgetFactories();
      const footer = f.mountFooter();
      const widgets = f.mountWidgets();
      f.controller[action](f.ctx);
      expectCleared(f);
      expect(f.instances[0]!.dispose).toHaveBeenCalledOnce();
      expect(f.footer.unsubscribes[0]).toHaveBeenCalledOnce();
      f.requestRender.mockClear();
      f.footer.callbacks[0]!();
      f.instances[0]!.requestRender();
      footer.dispose?.();
      expect(widgets.map((widget) => widget.render(80))).toEqual([[], []]);
      expect(oldWidgetFactories.map((factory) => factory(f.tui, f.theme).render(80))).toEqual([
        [],
        [],
      ]);
      expect(oldFooterFactory(f.tui, f.theme, f.footer.data).render(80)).toEqual([]);
      expect(f.footer.onBranchChange).toHaveBeenCalledOnce();
      expect(f.instances[0]!.refresh).not.toHaveBeenCalled();
      expect(f.instances[0]!.invalidate).not.toHaveBeenCalled();
      expect(f.instances[0]!.snapshot).not.toHaveBeenCalled();
      expect(f.requestRender).not.toHaveBeenCalled();
      expect(f.footer.unsubscribes[0]).toHaveBeenCalledOnce();
    },
  );

  it("rejects old branch/poller callbacks and old factories after session replacement", () => {
    const f = fixture();
    f.controller.sessionStarted(f.ctx);
    const oldFooterFactory = f.footerFactory();
    const oldWidgets = f.widgetFactories();
    const oldFooter = f.mountFooter();
    const mountedWidgets = f.mountWidgets();
    f.controller.sessionStarted({ ...f.ctx, cwd: "/work/replacement" });
    f.mountFooter();
    f.mountWidgets();
    f.requestRender.mockClear();
    oldFooter.dispose?.();
    f.footer.callbacks[0]!();
    f.instances[0]!.requestRender();
    expect(mountedWidgets.map((widget) => widget.render(80))).toEqual([[], []]);
    expect(oldWidgets.map((factory) => factory(f.tui, f.theme).render(80))).toEqual([[], []]);
    oldFooterFactory(f.tui, f.theme, f.footer.data);
    expect(f.footer.onBranchChange).toHaveBeenCalledTimes(2);
    for (const poller of f.instances) {
      expect(poller.refresh).not.toHaveBeenCalled();
      expect(poller.invalidate).not.toHaveBeenCalled();
    }
    expect(f.requestRender).not.toHaveBeenCalled();
    f.instances[1]!.requestRender();
    expect(f.requestRender).toHaveBeenCalledOnce();
    f.footer.callbacks[1]!();
    expect(f.instances[1]!.invalidate).toHaveBeenCalledOnce();
    expect(f.instances[1]!.refresh).toHaveBeenCalledExactlyOnceWith("/work/replacement");
    expect(f.footer.unsubscribes[1]).not.toHaveBeenCalled();
  });

  it("released footer callbacks stay inert within the same installation", () => {
    const f = fixture();
    f.controller.sessionStarted(f.ctx);
    const oldFooter = f.mountFooter();
    const currentFooter = f.mountFooter();
    expect(f.footer.unsubscribes[0]).toHaveBeenCalledOnce();
    oldFooter.dispose?.();
    f.footer.callbacks[0]!();
    expect(f.instances[0]!.invalidate).not.toHaveBeenCalled();
    expect(f.instances[0]!.refresh).not.toHaveBeenCalled();
    f.footer.callbacks[1]!();
    expect(f.instances[0]!.refresh).toHaveBeenCalledOnce();
    currentFooter.dispose?.();
    vi.mocked(f.instances[0]!.refresh).mockClear();
    vi.mocked(f.instances[0]!.invalidate).mockClear();
    f.requestRender.mockClear();
    f.footer.callbacks[1]!();
    expect(f.instances[0]!.refresh).not.toHaveBeenCalled();
    expect(f.instances[0]!.invalidate).not.toHaveBeenCalled();
    expect(f.requestRender).not.toHaveBeenCalled();
    expect(f.footer.unsubscribes[1]).toHaveBeenCalledOnce();
  });

  it("branch changes and widget renders refresh Git using the current event cwd", () => {
    const f = fixture();
    f.controller.sessionStarted(f.ctx);
    f.mountFooter();
    const widgets = f.mountWidgets();
    f.controller.updateContext({ ...f.ctx, cwd: "/work/current" });
    expect(f.requestRender).toHaveBeenCalledOnce();
    f.footer.callbacks[0]!();
    expect(f.instances[0]!.invalidate).toHaveBeenCalledOnce();
    expect(f.instances[0]!.refresh).toHaveBeenCalledExactlyOnceWith("/work/current");
    expect(f.requestRender).toHaveBeenCalledTimes(2);
    expect(widgets[1]!.render(120)[0]).toContain("current");
    expect(f.instances[0]!.refresh).toHaveBeenLastCalledWith("/work/current");
  });

  it("ignores context updates before installation, outside TUI, hidden and disposed", () => {
    const f = fixture();
    f.controller.updateContext(f.ctx);
    f.controller.sessionStarted(f.ctx);
    f.mountWidgets();
    f.controller.updateContext({ ...f.ctx, mode: "rpc", cwd: "/wrong" });
    expect(f.requestRender).not.toHaveBeenCalled();
    f.mountWidgets()[1]!.render(120);
    expect(f.instances[0]!.refresh).toHaveBeenLastCalledWith("/work/first");
    f.controller.hide(f.ctx);
    f.controller.updateContext(f.ctx);
    f.controller.dispose(f.ctx);
    f.controller.updateContext(f.ctx);
    expect(f.requestRender).not.toHaveBeenCalled();
  });

  it("dispose uses the fresh event context without touching an expired root context", () => {
    const f = fixture();
    let expired = false;
    const root = {
      ...f.ctx,
      get ui() {
        if (expired) throw new Error("expired root UI");
        return f.ui;
      },
      get cwd() {
        if (expired) throw new Error("expired root cwd");
        return "/work/root";
      },
    } as unknown as ExtensionContext;
    f.controller.sessionStarted(root);
    f.mountFooter();
    const widgets = f.mountWidgets();
    expired = true;
    const fresh = uiFixture();
    f.controller.dispose(fresh.ctx);
    expectCleared(fresh);
    expect(f.setFooter).toHaveBeenCalledOnce();
    expect(widgets.map((widget) => widget.render(80))).toEqual([[], []]);
    expect(f.instances[0]!.dispose).toHaveBeenCalledOnce();
    f.controller.show(fresh.ctx);
    f.controller.sessionStarted(fresh.ctx);
    f.controller.dispose(fresh.ctx);
    expect(f.createGit).toHaveBeenCalledOnce();
    expect(fresh.setFooter).toHaveBeenCalledOnce();
  });
});

describe("CompactEditorChromeController footer data", () => {
  it("bottom widgets read fresh statuses directly from Pi's footer data", () => {
    const f = fixture();
    f.controller.sessionStarted(f.ctx);
    f.mountFooter();
    const widgets = f.mountWidgets();
    expect(widgets[1]!.render(120)[0]).toContain("ready");
    f.footer.statuses.set("test", "updated status");
    expect(widgets[1]!.render(120)[0]).toContain("updated status");
    f.controller.hide(f.ctx);
    expect(widgets[1]!.render(120)).toEqual([]);
  });

  it("footer replacement releases old data/listener without old disposal clearing new data", () => {
    const f = fixture();
    f.controller.sessionStarted(f.ctx);
    const factory = f.footerFactory();
    const first = f.mountFooter();
    const widgets = f.mountWidgets();
    const next = footerFixture(new Map([["new", "latest"]]));
    const second = factory(f.tui, f.theme, next.data);
    expect(f.footer.unsubscribes[0]).toHaveBeenCalledOnce();
    first.dispose?.();
    expect(f.footer.unsubscribes[0]).toHaveBeenCalledOnce();
    expect(widgets[1]!.render(120)[0]).toContain("latest");
    second.dispose?.();
    second.dispose?.();
    expect(next.unsubscribes[0]).toHaveBeenCalledOnce();
    expect(widgets[1]!.render(80)).toEqual([" first "]);
    f.controller.dispose(f.ctx);
    expect(next.unsubscribes[0]).toHaveBeenCalledOnce();
  });

  it("disposed footer data is not read by bottom widgets", () => {
    const f = fixture();
    f.controller.sessionStarted(f.ctx);
    const footer = f.mountFooter();
    const widgets = f.mountWidgets();
    footer.dispose?.();
    f.footer.getExtensionStatuses.mockImplementation(() => {
      throw new Error("released footer data");
    });
    expect(widgets[1]!.render(80)).toEqual([" first "]);
  });

  it("clearing this extension's footer restores the default, not a previously installed footer", () => {
    const f = fixture();
    const previous = vi.fn<FooterFactory>();
    f.setFooter(previous);
    f.controller.show(f.ctx);
    f.controller.hide(f.ctx);
    expect(f.setFooter.mock.calls).toEqual([[previous], [expect.any(Function)], [undefined]]);
    expect(previous).not.toHaveBeenCalled();
  });
});
