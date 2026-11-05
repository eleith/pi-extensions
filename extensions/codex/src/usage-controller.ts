import { CodexAccountError, fetchCodexUsage, type CodexAccountRegistry } from "./client.ts";
import type { InspectorController, InspectorHost } from "./inspector.ts";
import type { InspectorContent } from "./inspector-view.ts";
import { formatCodexUsage } from "./usage.ts";

export interface UsageHost extends InspectorHost {
  readonly modelRegistry: CodexAccountRegistry;
}

interface UsageReport {
  content: InspectorContent;
  retryAfterMs?: number;
}

export class UsageController {
  private retryAt = 0;
  private disposed = false;

  constructor(
    private readonly inspector: InspectorController,
    private readonly fetchUsage: typeof fetchCodexUsage = fetchCodexUsage,
    private readonly now: () => number = Date.now,
  ) {}

  async report(ctx: UsageHost): Promise<void> {
    if (this.disposed) return;
    if (this.now() < this.retryAt) {
      const seconds = Math.ceil((this.retryAt - this.now()) / 1000);
      return this.inspector.show(ctx, "Usage", {
        message: `Codex account service is rate limited. Try again in ${seconds}s.`,
        level: "warning",
      });
    }
    // The request retains only its registry and signal, not a potentially replaced UI context.
    const registry = ctx.modelRegistry;
    let retryAfterMs: number | undefined;
    return this.inspector.show(ctx, "Usage", {
      loading: "Fetching Codex usage…",
      load: async (signal) => {
        const report = await this.readUsage(registry, signal);
        retryAfterMs = report.retryAfterMs;
        return report.content;
      },
      onReady: () => {
        if (retryAfterMs !== undefined) this.retryAt = this.now() + retryAfterMs;
      },
    });
  }

  dispose(): void {
    // The extension owns the shared inspector and cancels its work independently.
    this.disposed = true;
  }

  private async readUsage(
    registry: CodexAccountRegistry,
    signal: AbortSignal,
  ): Promise<UsageReport> {
    try {
      const data = await this.fetchUsage(registry, signal);
      if (signal.aborted) return { content: { message: "" } };
      const report = formatCodexUsage(data, this.now());
      return {
        content: {
          message: report ?? "Codex account service returned an unrecognized usage response.",
          level: report === undefined ? "warning" : "info",
        },
      };
    } catch (error) {
      // A cancelled request must not change the retry budget of a newer inspection.
      if (signal.aborted || this.disposed) return { content: { message: "" } };
      return {
        content: {
          message:
            error instanceof CodexAccountError
              ? error.message
              : "Could not read Codex account usage.",
          level: "warning",
        },
        retryAfterMs: error instanceof CodexAccountError ? error.retryAfterMs : undefined,
      };
    }
  }
}
