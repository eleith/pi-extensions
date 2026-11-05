import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

export class FramedText extends Text {
  private painter: (width: number) => string = () => "";
  private paintedWidth: number | undefined;
  private paintedText: string | undefined;
  private outputPad = 0;

  constructor() {
    super("", 0, 0);
  }

  setPainter(painter: (width: number) => string): void {
    this.painter = painter;
    this.invalidate();
  }

  override invalidate(): void {
    this.paintedWidth = undefined;
    super.invalidate();
  }

  override setPaddingX(padding: number): void {
    if (padding === this.outputPad) return;
    this.outputPad = padding;
    super.setPaddingX(padding);
  }

  override render(width: number): string[] {
    // Match Text's narrow-terminal clamp so the painter sees its actual content width.
    const maxPadding = Math.floor((width - 1) / 2);
    const availablePadding = Math.max(0, maxPadding);
    const padding = Math.min(this.outputPad, availablePadding);
    const contentWidth = Math.max(1, width - padding * 2);
    const paintWidth = Math.min(contentWidth, 210);
    if (this.paintedWidth !== paintWidth) {
      let text: string;
      try {
        text = this.painter(paintWidth);
        // Native Text cannot fit wide glyphs in a one-column content area.
        if (paintWidth === 1) {
          const narrowLines = frameBody(text, paintWidth, true);
          text = narrowLines.join("\n");
        }
      } catch {
        // Deferred painting runs outside Pi's guarded renderer callbacks.
        text = "Tool output could not be rendered.";
      }
      // Text.setText always clears its layout cache.
      if (text !== this.paintedText) {
        this.setText(text);
        this.paintedText = text;
      }
      this.paintedWidth = paintWidth;
    }
    return super.render(width);
  }
}

export function frameComponent(
  context: { lastComponent: Component | undefined; outputPad?: number },
  painter: (width: number) => string,
): FramedText {
  const component =
    context.lastComponent instanceof FramedText ? context.lastComponent : new FramedText();
  const outputPad = context.outputPad ?? 0;
  component.setPaddingX(outputPad);
  component.setPainter(painter);
  return component;
}

export type FrameStatus = "pending" | "success" | "error";

const STATUS_COLOR: Record<FrameStatus, ThemeColor> = {
  pending: "warning",
  success: "success",
  error: "error",
};

export interface RenderStateLike {
  readonly isError?: boolean;
  readonly isPartial?: boolean;
}

export function frameStatus(state: RenderStateLike): FrameStatus {
  if (state.isError) return "error";
  if (state.isPartial) return "pending";
  return "success";
}

export function frameTop(title: string, status: FrameStatus, theme: Theme, width: number): string {
  const border = borderPainter(status, theme);
  const safeWidth = Math.max(1, width);
  if (safeWidth < 6) return border("─".repeat(safeWidth));
  const maxTitleWidth = safeWidth - 5; // two dashes, spaces around title, at least one trailing dash
  const fittedTitle =
    visibleWidth(title) > maxTitleWidth ? truncateToWidth(title, maxTitleWidth, "…") : title;
  const trailingWidth = safeWidth - 4 - visibleWidth(fittedTitle);
  return `${border("──")} ${fittedTitle} ${border("─".repeat(trailingWidth))}`;
}

export function frameBottomWithLabel(
  label: string,
  status: FrameStatus,
  theme: Theme,
  width: number,
): string {
  const border = borderPainter(status, theme);
  const safeWidth = Math.max(1, width);
  if (safeWidth < 6) return border("─".repeat(safeWidth));
  const trailingBorderWidth = Math.min(8, safeWidth - 5);
  const maxLabelWidth = safeWidth - 3 - trailingBorderWidth; // leading dash, spaces around label, trailing dashes
  const fittedLabel =
    visibleWidth(label) > maxLabelWidth ? truncateToWidth(label, maxLabelWidth, "…") : label;
  const fillWidth = safeWidth - 2 - visibleWidth(fittedLabel) - trailingBorderWidth;
  return `${border("─".repeat(fillWidth))} ${fittedLabel} ${border("─".repeat(trailingBorderWidth))}`;
}

/** Clip compact bodies; wrap expanded bodies without changing the summary label. */
export function frameResultWithBottomLabel(
  body: string,
  label: string,
  status: FrameStatus,
  theme: Theme,
  width: number,
  expanded = false,
): string {
  const lines = body ? frameBody(body, width, expanded) : [];
  const footer = frameBottomWithLabel(label, status, theme, width);
  return [...lines, footer].join("\n");
}

/** Keep presentation state in the frame, separate from tool output. */
export function resultLabel(
  summary: string,
  expanded: boolean,
  hidden: number,
  theme: Theme,
): string {
  const view = theme.fg(
    "muted",
    expanded ? "expanded" : hidden ? `collapsed · ${hidden} hidden` : "collapsed",
  );
  return summary ? `${summary}${theme.fg("dim", " · ")}${view}` : view;
}

export function frameToolError(
  message: string,
  expanded: boolean,
  theme: Theme,
  width: number,
  options: { showHidden?: boolean } = {},
): string {
  const lines = (message || "Error").replace(/\r?\n$/, "").split("\n");
  const shown = expanded ? lines : lines.slice(0, 5);
  const hidden = lines.length - shown.length;
  const messageBody = shown.join("\n");
  const body = theme.fg("error", messageBody);
  const summary = theme.fg("error", "✗ error");
  const hiddenCount = options.showHidden === false ? 0 : hidden;
  const label = resultLabel(summary, expanded, hiddenCount, theme);
  return frameResultWithBottomLabel(body, label, "error", theme, width, expanded);
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (totalMinutes < 60) return seconds > 0 ? `${totalMinutes}m${seconds}s` : `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

function frameBody(body: string, width: number, expanded: boolean): string[] {
  const safeWidth = Math.max(1, width);
  const lines = expanded ? wrapTextWithAnsi(body, safeWidth) : body.split("\n");
  // A wide grapheme cannot fit in one column, even after native wrapping.
  return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
}

function borderPainter(status: FrameStatus, theme: Theme): (text: string) => string {
  return (text: string) => theme.fg(STATUS_COLOR[status], text);
}
