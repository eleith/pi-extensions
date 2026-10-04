import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contextProfile, modelKey } from "./profiles.ts";
import { CONTEXT_ENTRY, readPreferences, type ContextPreference } from "./state.ts";
import { formatContextStatus } from "./status.ts";

// Small ports keep the controller testable without starting Pi or calling a provider.
export type ContextAPI = Pick<
  ExtensionAPI,
  "setModel" | "getThinkingLevel" | "setThinkingLevel" | "appendEntry"
>;
export type ContextHost = Pick<
  ExtensionContext,
  "model" | "hasUI" | "isIdle" | "getContextUsage"
> & {
  readonly ui: Pick<ExtensionContext["ui"], "notify" | "confirm">;
  readonly sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "getBranch" | "getSessionId" | "getLeafId"
  >;
};

interface OwnedWindow {
  readonly model: Model<Api>;
  readonly standardWindow: number;
}

interface PendingSelection {
  readonly expected: Model<Api>;
  interrupted?: {
    readonly thinking: ReturnType<ContextAPI["getThinkingLevel"]>;
  };
}

function tokens(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : "unknown";
}

export class ContextController {
  private preferences = new Map<string, boolean>();
  private owned: OwnedWindow | undefined;
  private changing: AbortController | undefined;
  private selection: PendingSelection | undefined;
  private revision = 0;
  private disposed = false;

  constructor(
    private readonly pi: ContextAPI,
    private readonly commandName: string,
  ) {}

  async restore(ctx: ContextHost): Promise<void> {
    if (this.disposed) return;
    this.invalidate();
    this.preferences = readPreferences(ctx.sessionManager.getBranch());
    // session_tree fires before Pi releases its branch-summary lock. Reconcile
    // at the next idle prompt rather than silently lowering an owned window.
    if (ctx.isIdle()) await this.reconcile(ctx);
  }

  async modelSelected(ctx: ContextHost): Promise<void> {
    if (this.disposed) return;
    if (this.selection) {
      const model = ctx.model;
      if (model && model !== this.selection.expected) {
        this.selection.interrupted = { thinking: this.pi.getThinkingLevel() };
        // setModel retains the supplied object across its authentication awaits.
        // Update only our pending private copy so an older call cannot put the
        // previous model back. No second authentication attempt is needed.
        for (const key of Object.keys(this.selection.expected))
          Reflect.deleteProperty(this.selection.expected, key);
        Object.assign(this.selection.expected, model);
      }
      return;
    }
    this.invalidate();
    await this.reconcile(ctx);
  }

  async reconcile(ctx: ContextHost): Promise<void> {
    if (this.disposed || this.selection || this.changing) return;
    const model = ctx.model;
    if (this.owned?.model !== model) this.release();
    const profile = contextProfile(model);
    if (!model || !profile) return;

    const standardWindow = this.standardWindow(model);
    const extended = this.preferences.get(modelKey(model)) === true;
    const target = extended ? Math.max(standardWindow, profile.extendedWindow) : standardWindow;
    if (model.contextWindow === target) return;
    if (target < model.contextWindow && !ctx.isIdle()) return;
    const revision = this.revision;
    const operation = new AbortController();
    this.changing = operation;
    try {
      if (
        target < model.contextWindow &&
        !(await this.confirmReduction(ctx, model, target, operation.signal))
      ) {
        if (!operation.signal.aborted && revision === this.revision && ctx.model === model) {
          this.remember(model, true);
          ctx.ui.notify("Keeping extended context on this branch.", "info");
        }
        return;
      }
      await this.apply(ctx, model, standardWindow, target);
    } catch {
      if (!operation.signal.aborted && revision === this.revision) {
        ctx.ui.notify(
          `Could not restore the context window. Run /${this.commandName} before continuing.`,
          "warning",
        );
      }
    } finally {
      if (this.changing === operation) this.changing = undefined;
    }
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
    if (this.changing || this.selection || !ctx.isIdle()) {
      ctx.ui.notify("Wait for the current run or context change to finish.", "warning");
      return;
    }

    const model = ctx.model;
    const profile = contextProfile(model);
    if (!model || !profile) {
      ctx.ui.notify(
        "Extended context is configured for Codex GPT-6 Sol and Astra only.",
        "warning",
      );
      return;
    }

    const revision = this.revision;
    const operation = new AbortController();
    this.changing = operation;
    try {
      if (this.owned?.model !== model) this.release();
      const extended = action === "extend";
      const standardWindow = this.standardWindow(model);
      const target = extended ? Math.max(standardWindow, profile.extendedWindow) : standardWindow;

      if (
        target < model.contextWindow &&
        !(await this.confirmReduction(ctx, model, target, operation.signal))
      )
        return;
      if (!(await this.apply(ctx, model, standardWindow, target))) return;
      if (operation.signal.aborted || revision !== this.revision) return;

      this.remember(model, extended);
      ctx.ui.notify(
        `Context ${extended ? "extended" : "restored"}: ${tokens(target)} tokens.` +
          (extended
            ? " Larger requests can use more allowance; the server's limit still applies."
            : ""),
        "info",
      );
    } catch {
      if (!operation.signal.aborted && revision === this.revision) {
        ctx.ui.notify(
          `Could not change the context window. Check provider authentication and /${this.commandName}.`,
          "error",
        );
      }
    } finally {
      if (this.changing === operation) this.changing = undefined;
    }
  }

  shutdown(): void {
    this.disposed = true;
    this.invalidate();
    this.release();
    this.preferences.clear();
  }

  private remember(model: Model<Api>, extended: boolean): void {
    const key = modelKey(model);
    if (this.preferences.get(key) === extended) return;
    const preference: ContextPreference = { provider: model.provider, modelId: model.id, extended };
    this.pi.appendEntry(CONTEXT_ENTRY, preference);
    this.preferences.set(key, extended);
  }

  private standardWindow(model: Model<Api>): number {
    return this.owned?.model === model ? this.owned.standardWindow : model.contextWindow;
  }

  private status(ctx: ContextHost): void {
    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No model selected.", "info");
      return;
    }
    const profile = contextProfile(model);
    const standardWindow = this.standardWindow(model);
    ctx.ui.notify(
      formatContextStatus({
        model,
        usage: ctx.getContextUsage(),
        standardWindow,
        extendedWindow: profile ? Math.max(standardWindow, profile.extendedWindow) : undefined,
        branch: ctx.sessionManager.getBranch(),
      }),
      "info",
    );
  }

  private async confirmReduction(
    ctx: ContextHost,
    model: Model<Api>,
    target: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted || this.disposed) return false;
    const usage = ctx.getContextUsage()?.tokens;
    if (typeof usage === "number" && usage > target) {
      ctx.ui.notify(
        `Current context (${tokens(usage)}) exceeds ${tokens(target)} tokens. Run /compact while the context is extended, then try again.`,
        "warning",
      );
      return false;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("Reducing the context window requires interactive confirmation.", "warning");
      return false;
    }

    const revision = this.revision;
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    // Pi does not expose the live compaction reserve here. Confirm every reduction,
    // rather than guessing that a request below the window fits its threshold.
    const confirmed = await ctx.ui.confirm(
      "Use standard context?",
      `Window: ${tokens(model.contextWindow)} → ${tokens(target)} tokens. Current usage: ${tokens(usage)}. ` +
        "Pi may compact older history on the next request, depending on your compaction settings.",
      { signal },
    );
    // Shutdown invalidates ctx's getters. Do not even notify through an old context.
    if (!confirmed || signal.aborted || this.disposed || revision !== this.revision) return false;
    if (
      ctx.model !== model ||
      !ctx.isIdle() ||
      ctx.sessionManager.getSessionId() !== sessionId ||
      ctx.sessionManager.getLeafId() !== leafId
    ) {
      ctx.ui.notify(
        `The session changed while confirming. Try /${this.commandName} again.`,
        "warning",
      );
      return false;
    }
    return true;
  }

  private async apply(
    ctx: ContextHost,
    model: Model<Api>,
    standardWindow: number,
    target: number,
  ): Promise<boolean> {
    if (this.disposed || ctx.model !== model) return false;
    if (model.contextWindow === target) return true;
    const previousWindow = model.contextWindow;
    const copy: Model<Api> = { ...model, contextWindow: target };
    const revision = this.revision;
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const thinking = this.pi.getThinkingLevel();
    const selection: PendingSelection = { expected: copy };
    let applied = false;
    this.selection = selection;
    try {
      const accepted = await this.pi.setModel(copy);
      if (revision !== this.revision) return false;
      if (ctx.sessionManager.getSessionId() !== sessionId) return false;
      if (!this.selectionMatchesBranch(ctx, leafId, model)) return false;
      if (selection.interrupted) return false;
      if (!accepted) {
        ctx.ui.notify(
          "Could not change context: provider authentication is unavailable.",
          "warning",
        );
        return false;
      }
      if (ctx.model !== copy) return false;
      this.release();
      // setModel reapplies thinking defaults even for a metadata-only change.
      this.pi.setThinkingLevel(thinking);
      this.owned = target === standardWindow ? undefined : { model: copy, standardWindow };
      applied = true;
      return true;
    } catch (error) {
      if (!selection.interrupted && revision === this.revision && ctx.model === copy) {
        this.pi.setThinkingLevel(thinking);
      }
      throw error;
    } finally {
      this.selection = undefined;
      if (selection.interrupted) {
        if (revision === this.revision) {
          if (ctx.model === copy) this.pi.setThinkingLevel(selection.interrupted.thinking);
          this.release();
        }
      } else if (!applied) {
        // A hook can fail after assignment. Roll back the window, keeping ownership
        // if we were already extended. Shutdown always restores the baseline.
        copy.contextWindow = revision === this.revision ? previousWindow : standardWindow;
        if (revision === this.revision && ctx.model === copy) {
          this.pi.setThinkingLevel(thinking);
          this.release();
          this.owned =
            previousWindow === standardWindow ? undefined : { model: copy, standardWindow };
        }
      }
    }
  }

  private selectionMatchesBranch(
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
    // setModel records model/thinking changes. Allow those descendants, not a different branch.
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

  private invalidate(): void {
    this.revision++;
    this.changing?.abort();
    this.changing = undefined;
  }

  private release(): void {
    // Only our private copy is mutated. On reload/removal this restores its baseline
    // without authentication, a model switch, or a new transcript entry during shutdown.
    if (this.owned) this.owned.model.contextWindow = this.owned.standardWindow;
    this.owned = undefined;
  }
}
