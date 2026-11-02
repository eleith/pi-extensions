import { BorderedLoader, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CodexAccountError, fetchCodexUsage, type CodexAccountRegistry } from "./client.ts";
import { formatCodexUsage } from "./usage.ts";

export interface UsageHost {
  readonly mode: ExtensionContext["mode"];
  readonly modelRegistry: CodexAccountRegistry;
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
  readonly ui: Pick<ExtensionContext["ui"], "notify" | "custom">;
}

type UsageResult = { data: unknown } | { error: unknown };

interface PendingUsage {
  readonly controller: AbortController;
  readonly sessionId: string;
  // Owns only this interaction's loader and completion callback, never its context.
  closeLoader?: () => void;
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
    this.cancel();
    if (this.now() < this.retryAt) {
      const seconds = Math.ceil((this.retryAt - this.now()) / 1000);
      ctx.ui.notify(`Codex account service is rate limited. Try again in ${seconds}s.`, "warning");
      return;
    }
    const operation: PendingUsage = {
      controller: new AbortController(),
      sessionId: ctx.sessionManager.getSessionId(),
    };
    this.pending = operation;

    let result: UsageResult | undefined;
    try {
      const registry = ctx.modelRegistry;
      if (ctx.mode === "tui") {
        result = await this.readUsageWithLoader(operation, registry, ctx.ui);
      } else {
        // RPC has UI, but cannot host terminal components. Print/JSON use this too.
        ctx.ui.notify("Fetching Codex usage…", "info");
        result = await this.readUsageUntilCancelled(operation, registry);
      }
    } catch (error) {
      this.cancelOperation(operation);
      throw error;
    }
    // The custom interaction has closed before any final notification or context access.
    if (!this.canDeliverReport(operation, ctx) || result === undefined) {
      this.cancelOperation(operation);
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

    // A notification may reload the extension. Nothing may use ctx after this call.
    this.pending = undefined;
    ctx.ui.notify(message, level);
  }

  cancel(): void {
    const operation = this.pending;
    if (operation) this.cancelOperation(operation);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private readUsageWithLoader(
    operation: PendingUsage,
    registry: CodexAccountRegistry,
    ui: UsageHost["ui"],
  ): Promise<UsageResult | undefined> {
    // An owned overlay closes only itself; Pi 1.3 non-overlay completion resets the
    // editor/focus even when a newer interaction has taken over the shared surface.
    return ui.custom<UsageResult | undefined>(
      (tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Fetching Codex usage…");
        let closed = false;
        const onLoaderAbort = () => this.cancelOperation(operation);
        const closeLoader = (result?: UsageResult) => {
          if (closed) return;
          closed = true;
          operation.closeLoader = undefined;
          loader.signal.removeEventListener("abort", onLoaderAbort);
          // Dispose explicitly too: Pi may receive done before adopting the factory result.
          loader.dispose();
          done(result);
        };
        operation.closeLoader = () => closeLoader();
        loader.signal.addEventListener("abort", onLoaderAbort, { once: true });

        // Native dispose stops animation, but does not abort its signal. External disposal
        // must cancel our HTTP wait; disposal during successful close must not cancel delivery.
        const disposeLoader = loader.dispose.bind(loader);
        loader.dispose = () => {
          disposeLoader();
          if (!closed) this.cancelOperation(operation);
        };

        if (this.pending !== operation || operation.controller.signal.aborted) closeLoader();
        else void this.readUsageUntilCancelled(operation, registry).then(closeLoader);
        return loader;
      },
      { overlay: true },
    );
  }

  private readUsageUntilCancelled(
    operation: PendingUsage,
    registry: CodexAccountRegistry,
  ): Promise<UsageResult | undefined> {
    const { signal } = operation.controller;
    // Do not depend on an injected fetch implementation observing AbortSignal. Its late
    // fulfillment/rejection is observed, but can neither retain ctx nor reopen/close UI.
    return new Promise((resolve) => {
      let settled = false;
      const finishRead = (result?: UsageResult) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onReadAbort);
        resolve(result);
      };
      const onReadAbort = () => finishRead();
      signal.addEventListener("abort", onReadAbort, { once: true });
      if (signal.aborted) {
        finishRead();
        return;
      }
      try {
        void this.fetchUsage(registry, signal).then(
          (data) => finishRead({ data }),
          (error: unknown) => finishRead({ error }),
        );
      } catch (error) {
        finishRead({ error });
      }
    });
  }

  private cancelOperation(operation: PendingUsage): void {
    if (this.pending === operation) this.pending = undefined;
    operation.controller.abort();
    operation.closeLoader?.();
  }

  private canDeliverReport(operation: PendingUsage, ctx: UsageHost): boolean {
    // Invalidation must win before touching any potentially expired context getter.
    if (this.disposed || this.pending !== operation || operation.controller.signal.aborted)
      return false;
    return ctx.sessionManager.getSessionId() === operation.sessionId;
  }
}
