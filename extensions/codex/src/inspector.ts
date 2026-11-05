import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CodexInspectorView, type InspectorContent } from "./inspector-view.ts";

export interface InspectorHost {
  readonly mode: ExtensionContext["mode"];
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
  readonly ui: Pick<ExtensionContext["ui"], "notify" | "custom">;
}

export type InspectorSource =
  | InspectorContent
  | {
      loading: string;
      load: (signal: AbortSignal) => Promise<InspectorContent>;
      /** Commit request-side effects only after ownership and session validation. */
      onReady?: () => void;
    };

interface Inspection {
  readonly controller: AbortController;
  readonly sessionId: string;
  close?: () => void;
}

/** One owned, transient inspector. No entries, model calls, or background refresh. */
export class InspectorController {
  private pending: Inspection | undefined;
  private disposed = false;

  async show(ctx: InspectorHost, view: string, source: InspectorSource): Promise<void> {
    if (this.disposed) return;
    this.cancel();
    const operation: Inspection = {
      controller: new AbortController(),
      sessionId: ctx.sessionManager.getSessionId(),
    };
    this.pending = operation;
    try {
      if (ctx.mode === "tui") {
        await this.showOverlay(operation, ctx, view, source);
      } else {
        // RPC supports notifications, not terminal components. Preserve a textual fallback.
        if ("loading" in source) ctx.ui.notify(source.loading, "info");
        const content = await this.readUntilCancelled(operation, source);
        if (content && this.canDeliver(operation, ctx)) {
          if ("loading" in source) source.onReady?.();
          ctx.ui.notify(content.message, content.level ?? "info");
        }
      }
    } finally {
      this.cancelOperation(operation);
    }
  }

  cancel(): void {
    if (this.pending) this.cancelOperation(this.pending);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private showOverlay(
    operation: Inspection,
    ctx: InspectorHost,
    view: string,
    source: InspectorSource,
  ): Promise<void> {
    // Keep a single overlay alive through loading and results. Closing this interaction
    // never resets the shared editor or steals focus from a newer overlay.
    return ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        let closed = false;
        const component = new CodexInspectorView(
          tui,
          theme,
          keybindings,
          view,
          () => this.cancelOperation(operation),
          source,
        );
        const close = () => {
          if (closed) return;
          closed = true;
          operation.close = undefined;
          // Also dispose before adoption: Pi may receive done before using the factory result.
          component.dispose();
          done();
        };
        operation.close = close;
        if (!this.canDeliver(operation, ctx)) {
          this.cancelOperation(operation);
        } else if ("loading" in source) {
          void this.readUntilCancelled(operation, source).then((content) => {
            if (!content || !this.canDeliver(operation, ctx)) {
              this.cancelOperation(operation);
              return;
            }
            source.onReady?.();
            component.setContent(content);
          });
        }
        return component;
      },
      {
        overlay: true,
        // Let Pi clamp the width on resize; fixed margins can exceed tiny terminals.
        // The view owns vertical space, including when no margin fits.
        overlayOptions: { anchor: "center", width: 76 },
      },
    );
  }

  private readUntilCancelled(
    operation: Inspection,
    source: InspectorSource,
  ): Promise<InspectorContent | undefined> {
    const { signal } = operation.controller;
    if (!("loading" in source)) return Promise.resolve(signal.aborted ? undefined : source);
    // Observe late results without retaining a host context in an uncooperative request.
    return new Promise((resolve) => {
      let settled = false;
      const finish = (content?: InspectorContent) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(content);
      };
      const onAbort = () => finish();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        finish();
        return;
      }
      try {
        void source
          .load(signal)
          .then(finish, () =>
            finish({ message: "Could not read Codex information.", level: "warning" }),
          );
      } catch {
        finish({ message: "Could not read Codex information.", level: "warning" });
      }
    });
  }

  private canDeliver(operation: Inspection, ctx: InspectorHost): boolean {
    // Cancellation must win before accessing getters from a replaced extension runtime.
    if (this.disposed || this.pending !== operation || operation.controller.signal.aborted)
      return false;
    return ctx.sessionManager.getSessionId() === operation.sessionId;
  }

  private cancelOperation(operation: Inspection): void {
    if (this.pending === operation) this.pending = undefined;
    operation.controller.abort();
    operation.close?.();
  }
}
