import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CodexAccountError, fetchCodexUsage, type CodexAccountRegistry } from "./client.ts";
import { formatCodexUsage } from "./usage.ts";

export interface UsageHost {
  readonly modelRegistry: CodexAccountRegistry;
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
  readonly ui: Pick<ExtensionContext["ui"], "notify">;
}

export class UsageController {
  private pending: AbortController | undefined;
  private retryAt = 0;
  private disposed = false;

  constructor(
    private readonly fetchUsage: typeof fetchCodexUsage = fetchCodexUsage,
    private readonly now: () => number = Date.now,
  ) {}

  async report(ctx: UsageHost): Promise<void> {
    if (this.disposed) return;
    this.cancel();
    if (this.now() < this.retryAt) {
      const seconds = Math.ceil((this.retryAt - this.now()) / 1000);
      ctx.ui.notify(`Codex account service is rate limited. Try again in ${seconds}s.`, "warning");
      return;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const operation = new AbortController();
    this.pending = operation;
    try {
      const data = await this.fetchUsage(ctx.modelRegistry, operation.signal);
      if (!this.canDeliverReport(operation, ctx, sessionId)) return;
      const report = formatCodexUsage(data, this.now());
      if (report === undefined) {
        ctx.ui.notify("Codex account service returned an unrecognized usage response.", "warning");
      } else {
        ctx.ui.notify(report, "info");
      }
    } catch (error) {
      if (!this.canDeliverReport(operation, ctx, sessionId)) return;
      const message =
        error instanceof CodexAccountError ? error.message : "Could not read Codex account usage.";
      if (error instanceof CodexAccountError && error.retryAfterMs !== undefined) {
        this.retryAt = this.now() + error.retryAfterMs;
      }
      ctx.ui.notify(message, "warning");
    } finally {
      if (this.pending === operation) this.pending = undefined;
    }
  }

  cancel(): void {
    this.pending?.abort();
    this.pending = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private canDeliverReport(operation: AbortController, ctx: UsageHost, sessionId: string): boolean {
    if (this.disposed || this.pending !== operation || operation.signal.aborted) return false;
    return ctx.sessionManager.getSessionId() === sessionId;
  }
}
