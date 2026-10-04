import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACTIVE, CLEAR, START_AT_ZERO, transportName, writeProgress } from "./transport.ts";

const TEST_DURATION_MS = 20_000;

export class ProgressController {
  private enabled = true;
  private working = false;
  private keepalive: ReturnType<typeof setInterval> | undefined;
  private testTimeout: ReturnType<typeof setTimeout> | undefined;

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean, ctx: ExtensionContext): void {
    this.enabled = enabled;
    if (!enabled) this.stopIndicator();
    else if (this.working && ctx.mode === "tui") this.startIndicator();
  }

  toggle(ctx: ExtensionContext): void {
    this.setEnabled(!this.enabled, ctx);
  }

  startRun(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    this.working = true;
    if (this.testTimeout) this.stopIndicator();
    if (this.enabled) this.startIndicator();
  }

  settleRun(): void {
    this.working = false;
    this.stopIndicator();
  }

  reset(): void {
    this.settleRun();
  }

  dispose(): void {
    this.settleRun();
  }

  test(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Terminal progress test requires interactive Pi", "warning");
      return;
    }
    if (this.working) {
      ctx.ui.notify("Wait for the current agent run to finish before testing progress", "warning");
      return;
    }
    this.stopIndicator();
    this.startIndicator();
    this.testTimeout = setTimeout(() => {
      this.stopIndicator();
      ctx.ui.notify("Terminal progress test finished", "info");
    }, TEST_DURATION_MS);
    ctx.ui.notify(`Testing ${transportName()} for ${TEST_DURATION_MS / 1_000} seconds`, "info");
  }

  private startIndicator(): void {
    if (this.keepalive) return;
    // A single determinate frame may reset the animation's starting position.
    writeProgress(START_AT_ZERO);
    writeProgress(ACTIVE);
    this.keepalive = setInterval(() => writeProgress(ACTIVE), 1_000);
  }

  private stopIndicator(): void {
    const active = this.keepalive !== undefined || this.testTimeout !== undefined;
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.testTimeout) clearTimeout(this.testTimeout);
    this.keepalive = undefined;
    this.testTimeout = undefined;
    if (active) writeProgress(CLEAR);
  }
}
