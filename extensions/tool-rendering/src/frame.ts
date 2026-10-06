import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export class FramedText extends Text {
  private painter: (width: number) => string = () => "";
  private paintedWidth: number | undefined;
  private paintedText: string | undefined;

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

  override render(width: number): string[] {
    const paintWidth = Math.max(1, Math.min(width, 210));
    if (this.paintedWidth !== paintWidth) {
      let text: string;
      try {
        text = this.painter(paintWidth);
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
  context: { lastComponent: Component | undefined },
  painter: (width: number) => string,
): FramedText {
  const component =
    context.lastComponent instanceof FramedText ? context.lastComponent : new FramedText();
  component.setPainter(painter);
  return component;
}

/** Native renderers must not inherit our component's width-dependent painter. */
export function builtinContext<T extends { lastComponent: Component | undefined }>(context: T): T {
  return context.lastComponent instanceof FramedText
    ? { ...context, lastComponent: undefined }
    : context;
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

export function frameResultWithBottomLabel(
  body: string,
  label: string,
  status: FrameStatus,
  theme: Theme,
  width: number,
): string {
  const lines = body ? frameBody(body, width) : [];
  return [...lines, frameBottomWithLabel(label, status, theme, width)].join("\n");
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
): string {
  const lines = (message || "Error").replace(/\r?\n$/, "").split("\n");
  const shown = expanded ? lines : lines.slice(0, 5);
  const hidden = lines.length - shown.length;
  return frameResultWithBottomLabel(
    theme.fg("error", shown.join("\n")),
    resultLabel(theme.fg("error", "✗ error"), expanded, hidden, theme),
    "error",
    theme,
    width,
  );
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

function frameBody(body: string, width: number): string[] {
  return body.split("\n").map((line) => truncateToWidth(line, Math.max(1, width), "…"));
}

function borderPainter(status: FrameStatus, theme: Theme): (text: string) => string {
  return (text: string) => theme.fg(STATUS_COLOR[status], text);
}
