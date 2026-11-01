import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CodexAccountError, fetchCodexUsage, type CodexAccountRegistry } from "./client.ts";
import { formatCodexUsage } from "./usage.ts";

const STATUS_KEY = "eleith-codex-usage";

export interface UsageHost {
  readonly hasUI: boolean;
  readonly modelRegistry: CodexAccountRegistry;
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
  readonly ui: Pick<ExtensionContext["ui"], "notify" | "setStatus">;
}

interface PendingUsage {
  readonly controller: AbortController;
  readonly sessionId: string;
  indicatorVisible: boolean;
}

export class UsageController {
  private pending: PendingUsage | undefined;
  private retryAt = 0;
  private disposed = false;

  constructor(
    private readonly fetchUsage: typeof fetchCodexUsage = fetchCodexUsage,
    private readonly now: () => number = Date.now,
  ) {}

  async report(ctx: UsageHost): Promise<void> {
    if (this.disposed) return;
    this.cancel(ctx);
    if (this.now() < this.retryAt) {
      const seconds = Math.ceil((this.retryAt - this.now()) / 1000);
      ctx.ui.notify(`Codex account service is rate limited. Try again in ${seconds}s.`, "warning");
      return;
    }
    const operation: PendingUsage = {
      controller: new AbortController(),
      sessionId: ctx.sessionManager.getSessionId(),
      indicatorVisible: ctx.hasUI,
    };
    this.pending = operation;
    if (operation.indicatorVisible) {
      ctx.ui.setStatus(STATUS_KEY, "Codex: fetching usage…");
    } else {
      ctx.ui.notify("Fetching Codex usage…", "info");
    }
    if (!this.canDeliverReport(operation, ctx)) {
      this.finish(operation, ctx);
      return;
    }

    let result: { data: unknown } | { error: unknown };
    try {
      result = { data: await this.fetchUsage(ctx.modelRegistry, operation.controller.signal) };
    } catch (error) {
      result = { error };
    }
    if (!this.canDeliverReport(operation, ctx)) {
      this.finish(operation, ctx);
      return;
    }

    let message: string;
    let level: "info" | "warning" = "warning";
    if ("error" in result) {
      const error = result.error;
      message =
        error instanceof CodexAccountError ? error.message : "Could not read Codex account usage.";
      if (error instanceof CodexAccountError && error.retryAfterMs !== undefined) {
        this.retryAt = this.now() + error.retryAfterMs;
      }
    } else {
      const report = formatCodexUsage(result.data, this.now());
      message = report ?? "Codex account service returned an unrecognized usage response.";
      if (report !== undefined) level = "info";
    }

    // Clear before notifying: the notification itself may reload the extension.
    this.clearIndicator(operation, ctx);
    if (!this.canDeliverReport(operation, ctx)) {
      this.finish(operation, ctx);
      return;
    }
    this.pending = undefined;
    ctx.ui.notify(message, level);
  }

  cancel(ctx: UsageHost): void {
    const operation = this.pending;
    this.pending = undefined;
    if (!operation) return;
    operation.controller.abort();
    this.clearIndicator(operation, ctx);
  }

  dispose(ctx: UsageHost): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel(ctx);
  }

  private clearIndicator(operation: PendingUsage, ctx: UsageHost): void {
    if (!operation.indicatorVisible) return;
    operation.indicatorVisible = false;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  private finish(operation: PendingUsage, ctx: UsageHost): void {
    if (this.pending !== operation) return;
    this.pending = undefined;
    this.clearIndicator(operation, ctx);
  }

  private canDeliverReport(operation: PendingUsage, ctx: UsageHost): boolean {
    // Invalidation must win before touching any potentially expired context getter.
    if (this.disposed || this.pending !== operation || operation.controller.signal.aborted)
      return false;
    return ctx.sessionManager.getSessionId() === operation.sessionId;
  }
}
