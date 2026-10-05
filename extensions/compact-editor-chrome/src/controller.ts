import type { ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { GitStatusPoller } from "./git.ts";
import type { ChromeSnapshot } from "./types.ts";
import { BOTTOM_WIDGET, EmptyFooter, PromptStatusWidget, TOP_WIDGET } from "./widgets.ts";

type GitPoller = Pick<GitStatusPoller, "snapshot" | "refresh" | "invalidate" | "dispose">;

export class CompactEditorChromeController {
  private enabled = true;
  private disposed = false;
  private revision = 0;
  private tui: TUI | undefined;
  private ctx: ExtensionContext | undefined;
  private footerData: ReadonlyFooterDataProvider | undefined;
  private disposeFooterBranchListener: (() => void) | undefined;
  private git: GitPoller | undefined;

  constructor(
    private readonly createGit: (requestRender: () => void) => GitPoller = (requestRender) =>
      new GitStatusPoller(requestRender),
  ) {}

  sessionStarted(ctx: ExtensionContext): void {
    if (this.enabled) this.install(ctx);
  }

  show(ctx: ExtensionContext): void {
    this.enabled = true;
    this.install(ctx);
  }

  hide(ctx: ExtensionContext): void {
    this.enabled = false;
    this.uninstall(ctx);
  }

  toggle(ctx: ExtensionContext): void {
    if (this.enabled) this.hide(ctx);
    else this.show(ctx);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  updateContext(ctx: ExtensionContext): void {
    if (!this.ctx || this.disposed || ctx.mode !== "tui") return;
    this.ctx = ctx;
    this.requestRender();
  }

  requestRender(): void {
    this.tui?.requestRender();
  }

  dispose(ctx: ExtensionContext): void {
    this.disposed = true;
    this.uninstall(ctx);
  }

  private install(ctx: ExtensionContext): void {
    if (this.disposed || ctx.mode !== "tui") return;
    this.resetSessionState();
    this.ctx = ctx;
    const revision = this.revision;
    this.git = this.createGit(() => {
      if (this.isCurrent(revision)) this.requestRender();
    });
    ctx.ui.setWorkingVisible(true);
    this.installFooter(ctx, revision);
    this.installWidgets(ctx, revision);
  }

  private installFooter(ctx: ExtensionContext, revision: number): void {
    ctx.ui.setFooter((tui, _theme, footerData) => {
      if (!this.isCurrent(revision)) return new EmptyFooter();
      this.releaseFooterListener();
      this.tui = tui;
      this.footerData = footerData;
      let listening = true;
      const unsubscribe = footerData.onBranchChange(() => {
        if (!listening || !this.isCurrent(revision) || !this.ctx) return;
        this.git?.invalidate();
        this.git?.refresh(this.ctx.cwd);
        this.requestRender();
      });
      const release = () => {
        if (!listening) return;
        listening = false;
        unsubscribe();
        if (this.disposeFooterBranchListener === release) {
          this.disposeFooterBranchListener = undefined;
          this.footerData = undefined;
        }
      };
      this.disposeFooterBranchListener = release;
      return new EmptyFooter(release);
    });
  }

  private installWidgets(ctx: ExtensionContext, revision: number): void {
    const widget =
      (placement: "top" | "bottom"): Parameters<ExtensionContext["ui"]["setWidget"]>[1] =>
      (tui, theme) => {
        if (this.isCurrent(revision)) this.tui = tui;
        return new PromptStatusWidget(
          () => (this.isCurrent(revision) ? this.snapshot() : undefined),
          () => {
            if (this.isCurrent(revision)) this.refreshGit();
          },
          placement,
          theme,
        );
      };
    ctx.ui.setWidget(TOP_WIDGET, widget("top"));
    ctx.ui.setWidget(BOTTOM_WIDGET, widget("bottom"), { placement: "belowEditor" });
  }

  private uninstall(ctx: ExtensionContext): void {
    const installed = this.ctx !== undefined;
    this.resetSessionState();
    if (!installed || ctx.mode !== "tui") return;
    ctx.ui.setWorkingVisible(true);
    ctx.ui.setFooter(undefined);
    ctx.ui.setWidget(TOP_WIDGET, undefined);
    ctx.ui.setWidget(BOTTOM_WIDGET, undefined, { placement: "belowEditor" });
  }

  private snapshot(): ChromeSnapshot | undefined {
    if (!this.ctx) return undefined;
    return { ctx: this.ctx, footerData: this.footerData, gitStatus: this.git?.snapshot() ?? null };
  }

  private refreshGit(): void {
    if (this.ctx) this.git?.refresh(this.ctx.cwd);
  }

  private isCurrent(revision: number): boolean {
    return !this.disposed && this.enabled && !!this.ctx && this.revision === revision;
  }

  private releaseFooterListener(): void {
    this.disposeFooterBranchListener?.();
    this.disposeFooterBranchListener = undefined;
  }

  private resetSessionState(): void {
    this.revision++;
    this.git?.dispose();
    this.git = undefined;
    this.releaseFooterListener();
    this.tui = undefined;
    this.ctx = undefined;
    this.footerData = undefined;
  }
}
