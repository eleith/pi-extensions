import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type UsageContext = Pick<ExtensionContext, "model" | "sessionManager" | "getContextUsage">;
type Usage = ReturnType<ExtensionContext["getContextUsage"]>;

export class ContextUsageCache {
  private cached:
    | {
        sessionId: string;
        leafId: string | null;
        model: ExtensionContext["model"];
        contextWindow: number | undefined;
        usage: Usage;
      }
    | undefined;

  get(ctx: UsageContext): Usage {
    const model = ctx.model;
    // Virtual routing can change limits without changing ctx.model.
    if (model?.api === "pi-virtual") {
      this.cached = undefined;
      return ctx.getContextUsage();
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const contextWindow = model?.contextWindow;
    const cached = this.cached;
    if (
      cached &&
      cached.sessionId === sessionId &&
      cached.leafId === leafId &&
      cached.model === model &&
      cached.contextWindow === contextWindow
    ) {
      return cached.usage;
    }
    const usage = ctx.getContextUsage();
    this.cached = { sessionId, leafId, model, contextWindow, usage };
    return usage;
  }
}
