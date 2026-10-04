import type { AgentActivityOutcome, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completionBody, notificationTitle } from "./message.ts";
import { DesktopTransport, type Delivery, type NotificationTransport } from "./transports.ts";

const DEFAULT_MIN_DURATION_MS = 15_000;

export class DesktopNotifier {
  private enabled = true;
  private disposed = false;
  private runStartedAt: number | undefined;
  private outcome: AgentActivityOutcome | undefined;
  private pending: AbortController | undefined;

  constructor(
    private readonly transport: NotificationTransport = new DesktopTransport(),
    private readonly minDurationMs = DEFAULT_MIN_DURATION_MS,
  ) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancelPending();
  }

  toggle(): void {
    this.setEnabled(!this.enabled);
  }

  startRun(): void {
    if (this.disposed) return;
    // Continuations belong to the same run until final settlement.
    if (this.runStartedAt === undefined) this.cancelPending();
    this.runStartedAt ??= Date.now();
    this.outcome = undefined;
  }

  captureOutcome(outcome: AgentActivityOutcome): void {
    this.outcome = outcome;
  }

  async settleRun(ctx: ExtensionContext): Promise<void> {
    const startedAt = this.runStartedAt;
    const outcome = this.outcome;
    this.resetRun();
    if (startedAt === undefined || !this.enabled || this.disposed || ctx.mode !== "tui") return;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    if (outcome !== "aborted" && outcome !== "error" && elapsedMs < this.minDurationMs) return;
    await this.send(ctx, completionBody(outcome, elapsedMs));
  }

  async test(ctx: ExtensionContext): Promise<Delivery | undefined> {
    if (this.disposed) return undefined;
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Desktop notification test requires interactive Pi", "warning");
      return undefined;
    }
    return this.send(ctx, "Pi notification test");
  }

  reset(): void {
    this.resetRun();
    this.cancelPending();
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private async send(ctx: ExtensionContext, body: string): Promise<Delivery | undefined> {
    // Capture session data before asynchronous work can outlive this context.
    const cwd = ctx.cwd;
    const sessionName = ctx.sessionManager.getSessionName();
    this.cancelPending();
    const request = new AbortController();
    this.pending = request;
    try {
      const pane = await this.transport.paneTitle(request.signal);
      if (request.signal.aborted) return undefined;
      const title = notificationTitle(pane, cwd, sessionName);
      const delivery = await this.transport.deliver({ title, body }, request.signal);
      return request.signal.aborted ? undefined : delivery;
    } catch {
      return request.signal.aborted ? undefined : "none";
    } finally {
      if (this.pending === request) this.pending = undefined;
    }
  }

  private resetRun(): void {
    this.runStartedAt = undefined;
    this.outcome = undefined;
  }

  private cancelPending(): void {
    this.pending?.abort();
    this.pending = undefined;
  }
}
