import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contextProfile, modelKey } from "./profiles.ts";
import { CONTEXT_ENTRY, readPreferences, type ContextPreference } from "./state.ts";
import { formatContextStatus } from "./status.ts";

// Small public ports: no provider calls, catalog refresh, or settings-file reads.
export type ContextAPI = Pick<
  ExtensionAPI,
  "setModel" | "getThinkingLevel" | "setThinkingLevel" | "appendEntry"
>;
export type ContextHost = Pick<
  ExtensionContext,
  "model" | "hasUI" | "isIdle" | "getContextUsage"
> & {
  readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "find">;
  readonly ui: Pick<ExtensionContext["ui"], "notify" | "confirm">;
  readonly sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "getBranch" | "getSessionId" | "getLeafId"
  >;
};

function matches(current: Model<Api> | undefined, expected: Model<Api>): boolean {
  return (
    !!current &&
    current.provider === expected.provider &&
    current.id === expected.id &&
    current.api === expected.api &&
    current.baseUrl === expected.baseUrl &&
    current.contextWindow === expected.contextWindow &&
    current.maxTokens === expected.maxTokens
  );
}

function baseline(ctx: ContextHost, model: Model<Api>): number | undefined {
  const catalog = ctx.modelRegistry.find(model.provider, model.id);
  return catalog &&
    catalog.provider === model.provider &&
    catalog.id === model.id &&
    catalog.api === model.api &&
    catalog.baseUrl === model.baseUrl &&
    Number.isFinite(catalog.contextWindow) &&
    catalog.contextWindow > 0
    ? catalog.contextWindow
    : undefined;
}

function tokens(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : "unknown";
}

export class ContextController {
  private preferences = new Map<string, boolean>();
  private changing: AbortController | undefined;
  private selecting = false;
  private replayPaused = false;
  private revision = 0;
  private disposed = false;

  constructor(
    private readonly pi: ContextAPI,
    private readonly commandName: string,
  ) {}

  async restore(ctx: ContextHost): Promise<void> {
    if (this.disposed) return;
    this.invalidate(ctx);
    this.preferences = readPreferences(ctx.sessionManager.getBranch());
    // session_tree can still hold Pi's branch-summary lock. Replay at the next idle prompt.
    await this.reconcile(ctx);
  }

  async modelSelected(ctx: ContextHost): Promise<void> {
    if (this.disposed) return;
    // Our same-ID metadata selection emits no model_select in Pi. Any observed
    // event during work is interference, even if its effective values match.
    this.invalidate(ctx);
    await this.reconcile(ctx);
  }

  async reconcile(ctx: ContextHost): Promise<void> {
    if (this.disposed || this.replayPaused || this.selecting || this.changing || !ctx.isIdle())
      return;
    const model = ctx.model;
    if (!model || !contextProfile(model)) return;
    await this.change(ctx, this.preferences.get(modelKey(model)) === true, false);
  }

  async handle(args: string, ctx: ContextHost): Promise<void> {
    if (this.disposed) return;
    const action = args.trim().toLowerCase();
    if (!action) {
      this.status(ctx);
      return;
    }
    if (action !== "extend" && action !== "restore") {
      ctx.ui.notify(`Usage: /${this.commandName} [extend|restore]`, "info");
      return;
    }
    if (this.changing || this.selecting || !ctx.isIdle()) {
      ctx.ui.notify("Wait for the current run or context change to finish.", "warning");
      return;
    }
    this.replayPaused = false;
    await this.change(ctx, action === "extend", true);
  }

  shutdown(ctx?: ContextHost): void {
    if (this.disposed) return;
    this.invalidate(ctx);
    this.disposed = true;
    this.preferences.clear();
  }

  private async change(ctx: ContextHost, extended: boolean, command: boolean): Promise<void> {
    const current = ctx.model;
    const profile = contextProfile(current);
    if (!current || !profile) {
      if (command)
        ctx.ui.notify(
          "Extended context is configured for Codex GPT-6 Sol and Astra only.",
          "warning",
        );
      return;
    }
    const standardWindow = baseline(ctx, current);
    if (standardWindow === undefined) {
      ctx.ui.notify(
        "Catalog baseline is unknown or incompatible. Reselect a catalog model and inspect context status before changing the window.",
        "warning",
      );
      return;
    }
    const model = { ...current };
    const target = extended ? Math.max(standardWindow, profile.extendedWindow) : standardWindow;
    if (!command && model.contextWindow === target) return;
    const revision = this.revision;
    const operation = new AbortController();
    this.changing = operation;
    try {
      if (target < model.contextWindow) {
        const answer = await this.confirmReduction(ctx, model, target, operation.signal);
        if (!this.live(revision)) return;
        if (answer !== "confirmed") {
          if (
            !command &&
            answer === "declined" &&
            model.contextWindow === Math.max(standardWindow, profile.extendedWindow)
          ) {
            this.remember(model, true);
            ctx.ui.notify("Keeping extended context on this branch.", "info");
          }
          return;
        }
      }
      if (!this.live(revision) || !(await this.apply(ctx, model, target))) return;
      if (!this.live(revision)) return;
      if (command) {
        this.remember(model, extended);
        ctx.ui.notify(
          `Context ${extended ? "extended" : "restored"}: ${tokens(target)} tokens.` +
            (extended
              ? " Larger requests can use more allowance; the server's limit still applies."
              : standardWindow >= profile.extendedWindow
                ? " Already at the catalog baseline; no smaller default is known."
                : ""),
          "info",
        );
      }
    } catch {
      if (this.live(revision)) this.uncertain(ctx);
    } finally {
      if (this.changing === operation) this.changing = undefined;
    }
  }

  private remember(model: Model<Api>, extended: boolean): void {
    const key = modelKey(model);
    if (this.preferences.get(key) === extended) return;
    const preference: ContextPreference = { provider: model.provider, modelId: model.id, extended };
    this.pi.appendEntry(CONTEXT_ENTRY, preference);
    this.preferences.set(key, extended);
  }

  private status(ctx: ContextHost): void {
    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No model selected.", "info");
      return;
    }
    const profile = contextProfile(model);
    const standardWindow = baseline(ctx, model);
    ctx.ui.notify(
      formatContextStatus({
        model,
        usage: ctx.getContextUsage(),
        standardWindow,
        extendedWindow:
          profile && standardWindow !== undefined
            ? Math.max(standardWindow, profile.extendedWindow)
            : undefined,
        desiredExtended: this.preferences.get(modelKey(model)),
        replayPaused: this.replayPaused,
        branch: ctx.sessionManager.getBranch(),
      }),
      "info",
    );
  }

  private usageAllowsReduction(ctx: ContextHost, target: number): boolean {
    const usage = ctx.getContextUsage()?.tokens;
    if (typeof usage === "number" && Number.isFinite(usage) && usage > target) {
      ctx.ui.notify(
        `Current context (${tokens(usage)}) exceeds ${tokens(target)} tokens. Run /compact while the context is extended, then try again.`,
        "warning",
      );
      return false;
    }
    return true;
  }

  private async confirmReduction(
    ctx: ContextHost,
    model: Model<Api>,
    target: number,
    signal: AbortSignal,
  ): Promise<"confirmed" | "declined" | "blocked"> {
    if (!this.usageAllowsReduction(ctx, target)) return "blocked";
    if (!ctx.hasUI) {
      ctx.ui.notify("Reducing the context window requires interactive confirmation.", "warning");
      return "blocked";
    }
    const revision = this.revision;
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const confirmed = await ctx.ui.confirm(
      "Use standard context?",
      `Window: ${tokens(model.contextWindow)} → ${tokens(target)} tokens. Current usage: ${tokens(ctx.getContextUsage()?.tokens)}. ` +
        "Pi may compact older history on the next request, depending on your compaction settings.",
      { signal },
    );
    // Invalidation/shutdown can expire every getter, including ui. Check first.
    if (!this.live(revision) || signal.aborted) return "blocked";
    if (
      !matches(ctx.model, model) ||
      !ctx.isIdle() ||
      ctx.sessionManager.getSessionId() !== sessionId ||
      ctx.sessionManager.getLeafId() !== leafId
    ) {
      this.uncertain(ctx);
      return "blocked";
    }
    if (!this.usageAllowsReduction(ctx, target)) return "blocked";
    return confirmed ? "confirmed" : "declined";
  }

  private async apply(ctx: ContextHost, model: Model<Api>, target: number): Promise<boolean> {
    if (!matches(ctx.model, model) || !ctx.isIdle()) {
      this.uncertain(ctx);
      return false;
    }
    if (model.contextWindow === target) return true;
    const copy: Model<Api> = { ...model, contextWindow: target };
    const revision = this.revision;
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const thinking = this.pi.getThinkingLevel();
    this.selecting = true;
    try {
      const accepted = await this.pi.setModel(copy);
      if (!this.live(revision)) return false;
      if (
        ctx.sessionManager.getSessionId() !== sessionId ||
        !this.branchCompatible(ctx, leafId, model) ||
        !ctx.isIdle() ||
        !matches(ctx.model, accepted ? { ...model, contextWindow: target } : model)
      ) {
        this.uncertain(ctx);
        return false;
      }
      if (!accepted) {
        this.replayPaused = true;
        ctx.ui.notify(
          "Could not change context: provider authentication is unavailable. Automatic replay is paused; explicitly extend or restore after checking authentication.",
          "warning",
        );
        return false;
      }
      // setModel reapplies thinking defaults. Preserve only verified, uncontested success.
      this.pi.setThinkingLevel(thinking);
      return true;
    } finally {
      this.selecting = false;
    }
  }

  private branchCompatible(
    ctx: ContextHost,
    previousLeaf: string | null,
    model: Model<Api>,
  ): boolean {
    if (ctx.sessionManager.getLeafId() === previousLeaf) return true;
    const branch = ctx.sessionManager.getBranch();
    const index =
      previousLeaf === null ? -1 : branch.findIndex((entry) => entry.id === previousLeaf);
    if (previousLeaf !== null && index === -1) return false;
    const additions = branch.slice(index + 1);
    // Conservative interference evidence, NOT a receipt: matching SDK descendants
    // are expected, but don't identify the writer. Equivalent races are invisible.
    return (
      additions.length > 0 &&
      additions.every(
        (entry) =>
          entry.type === "thinking_level_change" ||
          (entry.type === "model_change" &&
            entry.provider === model.provider &&
            entry.modelId === model.id),
      )
    );
  }

  private live(revision: number): boolean {
    return !this.disposed && revision === this.revision;
  }

  private uncertain(ctx: ContextHost): void {
    this.replayPaused = true;
    ctx.ui.notify(
      `Context change interrupted or uncertain. In-flight selection cannot be cancelled and may replace your intended model. Inspect /${this.commandName}, reselect the intended model if needed, then explicitly extend or restore. Automatic replay is paused; try /${this.commandName} again when ready.`,
      "warning",
    );
  }

  private invalidate(ctx?: ContextHost): void {
    if (this.changing || this.selecting) {
      if (ctx) this.uncertain(ctx);
      else this.replayPaused = true;
    }
    this.revision++;
    this.changing?.abort();
    this.changing = undefined;
  }
}
