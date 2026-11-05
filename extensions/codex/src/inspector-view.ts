import {
  DynamicBorder,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Loader,
  ScrollView,
  Text,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

export interface InspectorContent {
  message: string;
  level?: "info" | "warning" | "error";
}

/** A compact custom-overlay document, using Pi's native components and scroll state. */
export class CodexInspectorView implements Component {
  private readonly body = new Container();
  private readonly scroll = new ScrollView(this.body);
  private readonly title: Text;
  private readonly footer = new Text("", 1, 0);
  private readonly border: DynamicBorder;
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
    this.title = new Text(`Codex · ${view}`, 1, 0);
    this.border = new DynamicBorder((text) => this.theme.fg("border", text));
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
    const bordered = height >= 5;
    const chromeHeight = Math.min(height, 2) + (bordered ? 2 : 0);
    const bodyHeight = Math.max(0, height - chromeHeight);
    this.updateFooter();

    // Pi 1.3's legacy overlay calls render(width) and clips the document, not a
    // viewport layout. ScrollView.render returns ALL child lines. This is the
    // only adapter needed: feed public geometry to native scroll/clamp logic,
    // then extract its viewport. No internal layout APIs or duplicate offsets.
    const rendered = this.scroll.render(width);
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
    if (bordered) lines.push(...this.border.render(width));
    if (height >= 2)
      lines.push(
        ...this.title
          .render(width)
          .slice(0, 1)
          .map((line) => this.theme.bold(this.theme.fg("accent", line))),
      );
    lines.push(...visible.map((line) => this.theme.fg(color, line)));
    lines.push(
      ...this.footer
        .render(width)
        .slice(0, 1)
        .map((line) => this.theme.fg("dim", line)),
    );
    if (bordered) lines.push(...this.border.render(width));
    // Text may encounter a glyph wider than a one-column terminal.
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private updateFooter(): void {
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
    this.footer.setText(hints.join(" · "));
  }

  invalidate(): void {
    this.scroll.invalidate();
    this.title.invalidate();
    this.footer.invalidate();
    this.border.invalidate();
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
