import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { bottomLeftStatus, topRightStatus } from "./format.ts";
import { ContextUsageCache } from "./context-usage.ts";
import type { ChromeSnapshot } from "./types.ts";

export const TOP_WIDGET = "eleith-prompt-status-top";
export const BOTTOM_WIDGET = "eleith-prompt-status-bottom";

export class EmptyFooter implements Component {
  constructor(private readonly onDispose: () => void = () => {}) {}
  render(): string[] {
    return [];
  }
  invalidate(): void {}
  dispose(): void {
    this.onDispose();
  }
}

export class PromptStatusWidget implements Component {
  private readonly usage = new ContextUsageCache();

  constructor(
    private readonly getSnapshot: () => ChromeSnapshot | undefined,
    private readonly onRender: () => void,
    private readonly placement: "top" | "bottom",
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    this.onRender();
    const snapshot = this.getSnapshot();
    if (!snapshot) return [];
    const separator = this.theme.fg("muted", "›");
    if (this.placement === "top") {
      const fitted = truncateToWidth(
        topRightStatus(
          {
            model: snapshot.ctx.model,
            thinkingLevel: snapshot.ctx.thinkingLevel,
            getContextUsage: () => this.usage.get(snapshot.ctx),
          },
          this.theme,
          separator,
          width,
        ),
        width,
        "…",
      );
      return [`${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}${fitted}`];
    }
    return bottomLeftStatus(
      snapshot.ctx,
      snapshot.footerData?.getExtensionStatuses(),
      snapshot.footerData?.getGitBranch() ?? null,
      snapshot.gitStatus,
      this.theme,
      separator,
      width,
    ).map((line) => truncateToWidth(line, width, "…"));
  }

  invalidate(): void {}
}
