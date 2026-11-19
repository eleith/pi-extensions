import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Loader,
  ScrollView,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

export interface InspectorContent {
  message: string;
  level?: "info" | "warning" | "error";
}

// Keep the title or first hint intact before spending columns on padding or other hints.
function chromeLine(width: number, [primary, ...rest]: readonly string[]): string {
  if (!primary) return "";
  const pad = visibleWidth(primary) + 2 <= width ? " " : "";
  let line = primary;
  for (const hint of rest) {
    const next = `${line} · ${hint}`;
    if (visibleWidth(next) + pad.length * 2 > width) break;
    line = next;
  }
  return truncateToWidth(`${pad}${line}${pad}`, width, "");
}

/** A compact custom-overlay document, using Pi's native components and scroll state. */
export class CodexInspectorView implements Component {
  private readonly body = new Container();
  private readonly scroll = new ScrollView(this.body);
  private readonly title: string;
  private content: InspectorContent | undefined;
  private loader: Loader | undefined;
  private closed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    view: string,
    private readonly onClose: () => void,
    initial: InspectorContent | { loading: string },
  ) {
    this.title = `Codex · ${view}`;
    if ("loading" in initial) {
      // Loader starts itself in Pi 1.3. Keep its cached text unstyled; apply the
      // current theme at render time without invalidate() causing a render loop.
      this.loader = new Loader(
        tui,
        (text) => text,
        (text) => text,
        initial.loading,
      );
      this.body.addChild(this.loader);
    } else {
      this.setContent(initial);
    }
  }

  setContent(content: InspectorContent): void {
    if (this.closed) return;
    this.stopLoader();
    this.content = { ...content };
    this.body.clear();
    this.body.addChild(new Text(content.message, 1, 0));
    this.scroll.scrollToStart();
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const rows = Math.max(0, Math.floor(this.tui.terminal.rows));
    width = Math.max(0, Math.floor(width));
    if (this.closed || width === 0 || rows === 0) return [];

    // Leave one terminal row above/below when space permits. At tiny heights,
    // drop margins, then borders, then body, preserving dismissal and title.
    const height = rows - (rows >= 7 ? 2 : 0);
    // The frame also needs space for two sides and Text's horizontal padding.
    const bordered = height >= 5 && width >= 5;
    const innerWidth = width - (bordered ? 2 : 0);
    const chromeHeight = Math.min(height, 2) + (bordered ? 2 : 0);
    const bodyHeight = Math.max(0, height - chromeHeight);

    // Pi 1.3's legacy overlay calls render(width) and clips the document, not a
    // viewport layout. ScrollView.render returns ALL child lines. This is the
    // only adapter needed: feed public geometry to native scroll/clamp logic,
    // then extract its viewport. No internal layout APIs or duplicate offsets.
    const rendered = this.scroll.render(innerWidth);
    // Loader includes a leading spacer for standalone use. Our shared chrome
    // already supplies spacing; don't let it hide the spinner in a one-row body.
    const document = this.loader ? rendered.slice(1) : rendered;
    this.scroll.updateLayout(document.length, bodyHeight, () => this.tui.requestRender());
    const visible = document.slice(
      this.scroll.scrollTop,
      this.scroll.scrollTop + this.scroll.viewportHeight,
    );
    let color: "text" | "muted" | "warning" | "error" = "text";
    if (this.loader) color = "muted";
    else if (this.content?.level === "warning" || this.content?.level === "error")
      color = this.content.level;
    const lines: string[] = [];
    if (height >= 2)
      lines.push(this.theme.bold(this.theme.fg("accent", chromeLine(innerWidth, [this.title]))));
    lines.push(...visible.map((line) => this.theme.fg(color, line)));
    const footer = chromeLine(innerWidth, this.footerHints());
    if (footer) lines.push(this.theme.fg("dim", footer));
    // Fit and pad before adding the sides, so wide glyphs can't displace a border.
    if (!bordered) return lines.map((line) => truncateToWidth(line, innerWidth, ""));
    const rule = "─".repeat(innerWidth);
    const side = this.theme.fg("border", "│");
    return [
      this.theme.fg("border", `╭${rule}╮`),
      ...lines.map((line) => `${side}${truncateToWidth(line, innerWidth, "", true)}${side}`),
      this.theme.fg("border", `╰${rule}╯`),
    ];
  }

  private footerHints(): string[] {
    const cancelKeys = this.keybindings.getKeys("tui.select.cancel");
    const closeKeys = this.loader
      ? cancelKeys
      : [...cancelKeys, ...this.keybindings.getKeys("tui.select.confirm")];
    const hints = closeKeys.length
      ? [`${closeKeys.join("/")} ${this.loader ? "cancel" : "close"}`]
      : [];
    for (const [up, down, label] of [
      ["tui.select.up", "tui.select.down", "scroll"],
      ["tui.select.pageUp", "tui.select.pageDown", "page"],
    ] as const) {
      const keys = [...this.keybindings.getKeys(up), ...this.keybindings.getKeys(down)];
      if (keys.length) hints.push(`${keys.join("/")} ${label}`);
    }
    return hints;
  }

  invalidate(): void {
    this.scroll.invalidate();
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      (!this.loader && this.keybindings.matches(data, "tui.select.confirm"))
    ) {
      this.dispose();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
    else if (this.keybindings.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
    else if (this.keybindings.matches(data, "tui.select.pageUp"))
      this.scroll.scrollBy(-this.scroll.viewportHeight);
    else if (this.keybindings.matches(data, "tui.select.pageDown"))
      this.scroll.scrollBy(this.scroll.viewportHeight);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopLoader();
    // Set the guard first: custom() completion may synchronously dispose us.
    this.onClose();
  }

  private stopLoader(): void {
    this.loader?.stop();
    this.loader = undefined;
  }
}
