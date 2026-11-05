import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DynamicBorder,
  type KeybindingsManager as AgentKeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  Loader,
  ScrollView,
  Text,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { CodexInspectorView, type InspectorContent } from "./inspector-view.ts";

const views: CodexInspectorView[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Real Theme with only the semantic roles exercised by this component.
function makeTheme(color = 39) {
  return new Theme(
    {
      accent: color,
      border: color,
      text: color,
      muted: color,
      dim: color,
      warning: color === 39 ? 214 : 220,
      error: color === 39 ? 196 : 160,
      thinkingXhigh: color,
    } as ConstructorParameters<typeof Theme>[0],
    { selectedBg: 0 } as ConstructorParameters<typeof Theme>[1],
    "truecolor",
  );
}

function setup(
  initial: InspectorContent | { loading: string } = { message: "Account allowance" },
  rows = 24,
) {
  const terminal = { rows, columns: 120 };
  const requestRender = vi.fn();
  const tui = { terminal, requestRender } as unknown as TUI;
  const theme = makeTheme();
  // Coding-agent publicly exports its manager as a type only. The native TUI
  // manager provides the same selection actions without private app internals.
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  const onClose = vi.fn();
  const view = new CodexInspectorView(
    tui,
    theme,
    keybindings as unknown as AgentKeybindingsManager,
    "Usage",
    onClose,
    initial,
  );
  views.push(view);
  return { view, terminal, requestRender, theme, keybindings, onClose };
}

const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());
const message = Array.from(
  { length: 40 },
  (_, index) => `line-${String(index).padStart(2, "0")}`,
).join("\n");
const body = (view: CodexInspectorView, width = 100) => plain(view.render(width)).slice(2, -2);

it("composes real native borders, text, container and ScrollView without a second box", () => {
  const borderRender = vi.spyOn(DynamicBorder.prototype, "render");
  const textRender = vi.spyOn(Text.prototype, "render");
  const containerRender = vi.spyOn(Container.prototype, "render");
  const scrollRender = vi.spyOn(ScrollView.prototype, "render");
  const { view, theme } = setup();
  const lines = view.render(80);
  expect(plain(lines)).toEqual([
    "─".repeat(80),
    " Codex · Usage",
    " Account allowance",
    expect.stringContaining("escape/ctrl+c/enter close"),
    "─".repeat(80),
  ]);
  expect(lines[0]).toBe(new DynamicBorder((text) => theme.fg("border", text)).render(80)[0]);
  expect(lines[1]).toBe(
    theme.bold(theme.fg("accent", new Text("Codex · Usage", 1, 0).render(80)[0])),
  );
  expect(borderRender).toHaveBeenCalledWith(80);
  expect(textRender).toHaveBeenCalledWith(80);
  expect(containerRender).toHaveBeenCalledWith(80);
  expect(scrollRender).toHaveBeenCalledWith(80);
});

describe.each([
  { message: `${message}\n中文 👩‍💻 é ${"longword".repeat(30)}` },
  { loading: `Fetching 中文 👩‍💻 ${"longword".repeat(30)}` },
])("native wrapping and bounds for %o", (initial) => {
  it("fits supplied widths and terminal heights, including zero and tiny dimensions", () => {
    const { view, terminal } = setup(initial);
    for (const rows of [0, 1, 2, 3, 4, 5, 6, 7, 10, 24]) {
      terminal.rows = rows;
      for (const width of [0, 1, 2, 3, 8, 20, 80]) {
        const lines = view.render(width);
        expect(lines.length, `width=${width}, rows=${rows}`).toBeLessThanOrEqual(
          rows >= 7 ? rows - 2 : rows,
        );
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        if (!width || !rows) expect(lines).toEqual([]);
      }
    }
  });
});

it("keeps title and dismissal visible on short terminals, dropping borders before chrome", () => {
  const { view, terminal } = setup({ message }, 3);
  expect(plain(view.render(100))).toEqual([
    " Codex · Usage",
    " line-00",
    expect.stringContaining("close"),
  ]);
  terminal.rows = 2;
  expect(plain(view.render(100))).toEqual([" Codex · Usage", expect.stringContaining("close")]);
  terminal.rows = 1;
  expect(plain(view.render(100))).toEqual([expect.stringContaining("close")]);
});

it("scrolls the native viewport by line and page, clamps, and pins header/footer", () => {
  const { view, requestRender } = setup({ message }, 12);
  const original = plain(view.render(100));
  expect(body(view)).toEqual(Array.from({ length: 6 }, (_, index) => ` line-0${index}`));
  view.handleInput("\x1b[B");
  expect(body(view)[0]).toBe(" line-01");
  view.handleInput("\x1b[6~");
  expect(body(view)[0]).toBe(" line-07");
  view.handleInput("\x1b[5~");
  expect(body(view)[0]).toBe(" line-01");
  view.handleInput("\x1b[A");
  view.handleInput("\x1b[A");
  expect(body(view)[0]).toBe(" line-00");
  requestRender.mockClear();
  for (let index = 0; index < 100; index++) view.handleInput("\x1b[B");
  const end = plain(view.render(100));
  expect(body(view)[0]).toBe(" line-34");
  expect(body(view).at(-1)).toBe(" line-39");
  expect(end.slice(0, 2)).toEqual(original.slice(0, 2));
  expect(end.slice(-2)).toEqual(original.slice(-2));
  expect(requestRender).toHaveBeenCalled();
});

it("reflows on width/height resize and uses native clamping after growing the viewport", () => {
  const { view, terminal } = setup({ message }, 12);
  view.render(100);
  for (let index = 0; index < 100; index++) view.handleInput("\x1b[6~");
  expect(body(view)[0]).toBe(" line-34");
  terminal.rows = 20;
  expect(body(view)[0]).toBe(" line-26");
  expect(body(view)).toHaveLength(14);
  expect(body(view).at(-1)).toBe(" line-39");
  // Text, not the overlay adapter, owns wrapping at the new width.
  view.setContent({ message: "A long message with 中文 characters and wrapping words." });
  terminal.rows = 40;
  const expected = plain(
    new Text("A long message with 中文 characters and wrapping words.", 1, 0).render(12),
  );
  expect(body(view, 12)).toEqual(expected);
  terminal.rows = 8;
  const small = view.render(12);
  expect(small).toHaveLength(6);
  expect(plain(small)[1]).toContain("Codex");
  expect(plain(small).at(-2)).toContain("escape");
});

it("uses the injected remapped actions for dismissal, scrolling, and every hint", () => {
  const { view, keybindings, onClose } = setup({ message }, 12);
  keybindings.setUserBindings({
    "tui.select.up": "k",
    "tui.select.down": "j",
    "tui.select.pageUp": "u",
    "tui.select.pageDown": "d",
    "tui.select.cancel": "ctrl+x",
    "tui.select.confirm": "ctrl+y",
  });
  const footer = plain(view.render(100)).at(-2);
  expect(footer).toContain("ctrl+x/ctrl+y close");
  expect(footer).toContain("k/j scroll");
  expect(footer).toContain("u/d page");
  view.handleInput("\x1b[B");
  expect(body(view)[0]).toBe(" line-00");
  view.handleInput("j");
  expect(body(view)[0]).toBe(" line-01");
  view.handleInput("d");
  expect(body(view)[0]).toBe(" line-07");
  view.handleInput("u");
  view.handleInput("k");
  expect(body(view)[0]).toBe(" line-00");
  view.handleInput("\x1b");
  view.handleInput("\r");
  expect(onClose).not.toHaveBeenCalled();
  view.handleInput("\x19");
  expect(onClose).toHaveBeenCalledOnce();
});

it.each(["info", "warning", "error"] as const)(
  "renders %s from plain state with the current theme on every render",
  (level) => {
    const { view, theme, requestRender } = setup({ message: "Result", level });
    const before = view.render(100);
    const color = level === "info" ? "text" : level;
    expect(before[2]).toBe(theme.fg(color, new Text("Result", 1, 0).render(100)[0]));
    const nextTheme = makeTheme(201);
    const fg = vi.spyOn(theme, "fg").mockImplementation((token, text) => nextTheme.fg(token, text));
    requestRender.mockClear();
    const after = view.render(100);
    expect(after[0]).toContain(nextTheme.getFgAnsi("border"));
    expect(after[1]).toContain(nextTheme.getFgAnsi("accent"));
    expect(after[2]).toContain(nextTheme.getFgAnsi(color));
    expect(after.at(-2)).toContain(nextTheme.getFgAnsi("dim"));
    expect(plain(after)).toEqual(plain(before));
    view.invalidate();
    expect(view.render(100)).toEqual(after);
    expect(fg).toHaveBeenCalledWith(color, expect.stringContaining("Result"));
    expect(requestRender).not.toHaveBeenCalled();
  },
);

it("shows loading text even when the body has only one row", () => {
  const { view } = setup({ loading: "Fetching allowance" }, 7);
  expect(plain(view.render(100))).toEqual([
    "─".repeat(100),
    " Codex · Usage",
    expect.stringContaining("Fetching allowance"),
    expect.stringContaining("cancel"),
    "─".repeat(100),
  ]);
});

it("does not advertise disabled bindings or fall back to default dismissal keys", () => {
  const { view, keybindings, onClose } = setup();
  keybindings.setUserBindings({
    "tui.select.cancel": [],
    "tui.select.confirm": "ctrl+y",
    "tui.select.up": [],
    "tui.select.down": [],
    "tui.select.pageUp": [],
    "tui.select.pageDown": [],
  });
  expect(plain(view.render(100)).at(-2)).toBe(" ctrl+y close");
  view.handleInput("\x1b");
  view.handleInput("\x03");
  expect(onClose).not.toHaveBeenCalled();
  view.handleInput("\x19");
  expect(onClose).toHaveBeenCalledOnce();
});

it("animates a real Loader, refreshes its theme without a render loop, and stops on content", () => {
  const loaderRender = vi.spyOn(Loader.prototype, "render");
  const { view, theme, requestRender, keybindings, onClose } = setup({
    loading: "Fetching allowance",
  });
  keybindings.setUserBindings({ "tui.select.cancel": "ctrl+x", "tui.select.confirm": "ctrl+y" });
  expect(vi.getTimerCount()).toBe(1);
  const first = view.render(100);
  expect(loaderRender).toHaveBeenCalledWith(100);
  expect(plain(first).at(-2)).toContain("ctrl+x cancel");
  expect(plain(first).at(-2)).not.toContain("ctrl+y");
  view.handleInput("\x19");
  expect(onClose).not.toHaveBeenCalled();
  requestRender.mockClear();
  vi.advanceTimersByTime(80);
  expect(requestRender).toHaveBeenCalledOnce();
  const second = view.render(100);
  expect(second).not.toEqual(first);
  const nextTheme = makeTheme(201);
  vi.spyOn(theme, "fg").mockImplementation((token, text) => nextTheme.fg(token, text));
  requestRender.mockClear();
  expect(view.render(100).join("\n")).toContain(nextTheme.getFgAnsi("muted"));
  expect(requestRender).not.toHaveBeenCalled();
  view.invalidate();
  view.setContent({ message: "Failed to fetch allowance", level: "error" });
  expect(vi.getTimerCount()).toBe(0);
  expect(plain(view.render(100)).join("\n")).toContain("Failed to fetch allowance");
  expect(plain(view.render(100)).at(-2)).toContain("ctrl+x/ctrl+y close");
  requestRender.mockClear();
  vi.advanceTimersByTime(1000);
  expect(requestRender).not.toHaveBeenCalled();
});

it("resets scroll for replacement content and ignores updates after disposal", () => {
  const { view, requestRender } = setup({ message }, 12);
  view.render(100);
  view.handleInput("\x1b[6~");
  view.setContent({ message: "Replacement", level: "warning" });
  expect(body(view)).toEqual([" Replacement"]);
  view.dispose();
  requestRender.mockClear();
  view.setContent({ message: "Too late" });
  view.handleInput("\x1b[B");
  expect(view.render(100)).toEqual([]);
  expect(requestRender).not.toHaveBeenCalled();
});

it.each(["\x1b", "\x03", "\r", "dispose"])(
  "closes exactly once for %j, including recursive disposal",
  (input) => {
    const { view, onClose } = setup();
    onClose.mockImplementation(() => view.dispose());
    if (input === "dispose") view.dispose();
    else view.handleInput(input);
    view.dispose();
    view.handleInput("\x1b");
    expect(onClose).toHaveBeenCalledOnce();
  },
);

it.each(["cancel", "dispose"])("stops the loader and notifies once on loading %s", (action) => {
  const { view, onClose, requestRender, keybindings } = setup({ loading: "Fetching" });
  keybindings.setUserBindings({ "tui.select.cancel": "ctrl+x" });
  expect(vi.getTimerCount()).toBe(1);
  if (action === "cancel") view.handleInput("\x18");
  else view.dispose();
  expect(vi.getTimerCount()).toBe(0);
  view.dispose();
  expect(onClose).toHaveBeenCalledOnce();
  requestRender.mockClear();
  vi.advanceTimersByTime(1000);
  expect(requestRender).not.toHaveBeenCalled();
});
