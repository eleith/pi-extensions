import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const SPINNER_FRAMES = ["◰", "◳", "◲", "◱"] as const;
const SPINNER_INTERVAL_MS = 300;
const IDLE_ICON = "π";

// Titles are sent in an OSC escape sequence; never include terminal controls from a session name.
function safeLabel(value: string): string {
  return (
    value
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function folder(ctx: ExtensionContext): string {
  return safeLabel(basename(ctx.cwd)) || "pi";
}

export class TitleController {
  private enabled = true;
  private working = false;
  private spinner: ReturnType<typeof setInterval> | undefined;
  private pendingRender: ReturnType<typeof setImmediate> | undefined;
  private frameIndex = 0;
  private cachedSessionName: string | undefined;

  constructor(private readonly getSessionName: () => string | undefined) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  show(ctx: ExtensionContext): void {
    this.enabled = true;
    this.stop();
    if (this.working) this.startSpinner(ctx);
    else this.render(ctx);
  }

  hide(ctx: ExtensionContext): void {
    this.enabled = false;
    this.stop();
    if (ctx.mode !== "tui") return;
    const name = this.sessionName();
    ctx.ui.setTitle(name ? `π - ${name} - ${folder(ctx)}` : `π - ${folder(ctx)}`);
  }

  toggle(ctx: ExtensionContext): void {
    if (this.enabled) this.hide(ctx);
    else this.show(ctx);
  }

  sessionStarted(ctx: ExtensionContext): void {
    this.cachedSessionName = undefined;
    this.working = false;
    this.stop();
    this.renderAfterPi(ctx);
  }

  sessionInfoChanged(ctx: ExtensionContext): void {
    this.cachedSessionName = undefined;
    this.renderAfterPi(ctx);
  }

  startRun(ctx: ExtensionContext): void {
    this.working = true;
    this.startSpinner(ctx);
  }

  settleRun(ctx: ExtensionContext): void {
    this.working = false;
    this.stop();
    if (this.enabled) this.render(ctx);
  }

  dispose(): void {
    this.working = false;
    this.stop();
  }

  private sessionName(): string {
    this.cachedSessionName ??= safeLabel(this.getSessionName() ?? "");
    return this.cachedSessionName;
  }

  private render(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const icon = this.spinner
      ? (SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0])
      : IDLE_ICON;
    ctx.ui.setTitle(`${icon} - ${this.sessionName() || folder(ctx)}`);
  }

  // Pi writes its own title after startup and when the session is renamed.
  private renderAfterPi(ctx: ExtensionContext): void {
    if (!this.enabled || ctx.mode !== "tui") return;
    if (this.pendingRender) clearImmediate(this.pendingRender);
    this.pendingRender = setImmediate(() => {
      this.pendingRender = undefined;
      if (this.enabled) this.render(ctx);
    });
  }

  private startSpinner(ctx: ExtensionContext): void {
    if (!this.enabled || ctx.mode !== "tui" || this.spinner) return;
    this.spinner = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      this.render(ctx);
    }, SPINNER_INTERVAL_MS);
    this.spinner.unref();
    this.render(ctx);
  }

  private stop(): void {
    if (this.spinner) clearInterval(this.spinner);
    if (this.pendingRender) clearImmediate(this.pendingRender);
    this.spinner = undefined;
    this.pendingRender = undefined;
    this.frameIndex = 0;
  }
}
