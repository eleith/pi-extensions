import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderStreamEvent,
} from "@earendil-works/pi-coding-agent";
import {
  CodexAccountError,
  fetchCodexModelCatalog,
  readCodexAuthScope,
  type CodexAccountRegistry,
} from "./client.ts";
import { codexFastEligibility, type FastEligibility } from "./capabilities.ts";
import {
  FAST_ENTRY,
  readFastPreferences,
  type FastChoice,
  type FastPreference,
} from "./fast-state.ts";
import {
  formatFastStatus,
  type FastStatus,
  type FastRequestPolicy,
  type ObservedTier,
} from "./fast-status.ts";
import { modelKey } from "./profiles.ts";
import {
  isDirectCodexSelection,
  matchesDirectCodexSelection,
  type DirectCodexHost,
} from "./request-scope.ts";

const CAPABILITY_TTL_MS = 5 * 60_000;

export interface FastHost extends DirectCodexHost {
  readonly modelRegistry: CodexAccountRegistry &
    Pick<
      ExtensionContext["modelRegistry"],
      "getRegisteredProviderConfig" | "getRegisteredNativeProvider"
    >;
  readonly hasUI: boolean;
  readonly isIdle: ExtensionContext["isIdle"];
  readonly ui: Pick<ExtensionContext["ui"], "notify" | "confirm">;
  readonly sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "getBranch" | "getSessionId" | "getLeafId"
  >;
}

interface EligibilityPreparation {
  abortController: AbortController;
  sessionId: string;
  leafId: string | null;
  modelKey: string;
  api: string;
  baseUrl: string;
}

interface CachedEligibility {
  modelKey: string;
  authScope: string;
  eligibility: FastEligibility;
  expiresAt: number;
}

interface ModelTierActivity {
  modelKey: string;
  sessionId: string;
  observed: ObservedTier | undefined;
  conflict: boolean;
}

export class FastController {
  private preferences = new Map<string, FastPreference>();
  private cachedEligibility: CachedEligibility | undefined;
  private pendingPreparation: EligibilityPreparation | undefined;
  private modelTierActivity: ModelTierActivity | undefined;
  // Honor endpoint Retry-After across model/branch changes; account switching is not supported.
  private retryAt = 0;
  private disposed = false;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "appendEntry">,
    private readonly commandName: string,
    private readonly fetchCatalog: typeof fetchCodexModelCatalog = fetchCodexModelCatalog,
    private readonly readAuthScope: typeof readCodexAuthScope = readCodexAuthScope,
    private readonly now: () => number = Date.now,
  ) {}

  restore(ctx: FastHost): void {
    if (this.disposed) return;
    this.invalidate();
    this.preferences = readFastPreferences(ctx.sessionManager.getBranch());
  }

  getStatus(ctx: FastHost): FastStatus | undefined {
    if (this.disposed) return undefined;
    const model = ctx.model;
    if (!model) return undefined;
    const selectedModelKey = modelKey(model);
    const direct = isDirectCodexSelection(ctx);
    let activity = this.modelTierActivity;
    if (
      !activity ||
      !direct ||
      activity.modelKey !== selectedModelKey ||
      activity.sessionId !== ctx.sessionManager.getSessionId()
    )
      activity = undefined;
    let eligibility: FastEligibility = "unknown";
    if (direct) eligibility = this.currentEligibility(selectedModelKey);
    return {
      preference: this.preferenceFor(selectedModelKey),
      eligibility,
      requestPolicy: this.requestPolicy(ctx),
      lastObserved: activity?.observed,
      conflict: activity?.conflict ?? false,
    };
  }

  async handle(args: string, ctx: FastHost): Promise<void> {
    if (this.disposed) return;
    const action = args.trim().toLowerCase();
    if (!["on", "off", "toggle"].includes(action)) {
      ctx.ui.notify(`Usage: /${this.commandName} fast [on|off|toggle]`, "warning");
      return;
    }
    if (this.pendingPreparation || !ctx.isIdle()) {
      ctx.ui.notify("Wait for the current run or fast-mode change to finish.", "warning");
      return;
    }
    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No model selected.", "warning");
      return;
    }
    let mode: "on" | "off";
    if (action === "off") mode = "off";
    else if (action === "toggle" && this.preferenceFor(modelKey(model)) === "on") mode = "off";
    else mode = "on";

    if (!isDirectCodexSelection(ctx)) {
      ctx.ui.notify(
        "Fast controls require a direct official legacy Codex model with Pi OAuth and no provider override.",
        "warning",
      );
      return;
    }
    if (mode === "off") {
      this.rememberChoice(ctx, mode);
      this.report(ctx);
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Enabling fast mode requires interactive confirmation of higher allowance consumption.",
        "warning",
      );
      return;
    }
    await this.enable(ctx);
  }

  // Only ordinary idle input prepares saved on choices. Never fetch from request/stream hooks.
  async prepare(ctx: FastHost): Promise<void> {
    if (this.disposed || this.pendingPreparation || !ctx.isIdle()) return;
    const model = ctx.model;
    if (!model || this.preferenceFor(modelKey(model)) !== "on" || !isDirectCodexSelection(ctx))
      return;
    const preparation = this.startPreparation(ctx);
    try {
      await this.refreshEligibility(ctx, preparation, false);
    } catch (error) {
      this.reportPreparationFailure(error, ctx, preparation);
    } finally {
      if (this.pendingPreparation === preparation) this.pendingPreparation = undefined;
    }
  }

  transform(payload: unknown, ctx: FastHost): Record<string, unknown> | undefined {
    if (this.disposed) return;
    if (!matchesDirectCodexSelection(payload, ctx) || !ctx.model) {
      this.modelTierActivity = undefined;
      return;
    }
    const activity: ModelTierActivity = {
      modelKey: modelKey(ctx.model),
      sessionId: ctx.sessionManager.getSessionId(),
      observed: undefined,
      conflict: false,
    };
    this.modelTierActivity = activity;
    const policy = this.requestPolicy(ctx);
    if (policy !== "priority" && policy !== "default") return;
    if (payload.service_tier !== undefined && payload.service_tier !== policy) {
      activity.conflict = true;
      return;
    }
    if (payload.service_tier === policy) return;
    return { ...payload, service_tier: policy };
  }

  observe(event: ProviderStreamEvent, ctx: FastHost): void {
    if (this.disposed) return;
    const activity = this.modelTierActivity;
    if (!activity || !isDirectCodexSelection(ctx) || !ctx.model) return;
    if (
      event.provider !== ctx.model.provider ||
      event.api !== ctx.model.api ||
      event.model !== ctx.model.id
    )
      return;
    if (
      activity.modelKey !== modelKey(ctx.model) ||
      activity.sessionId !== ctx.sessionManager.getSessionId()
    )
      return;
    const data = readObject(event.data);
    if (!data || typeof data.type !== "string") return;
    if (!["response.completed", "response.done", "response.incomplete"].includes(data.type)) return;
    const tier = readObject(data.response)?.service_tier;
    activity.observed = readObservedTier(tier);
  }

  invalidate(): void {
    this.pendingPreparation?.abortController.abort();
    this.pendingPreparation = undefined;
    this.cachedEligibility = undefined;
    this.modelTierActivity = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    this.preferences.clear();
  }

  private async enable(ctx: FastHost): Promise<void> {
    const preparation = this.startPreparation(ctx);
    try {
      const confirmed = await ctx.ui.confirm(
        "Enable Codex fast mode?",
        "Priority requests use more of your Codex allowance. This branch/model choice can also affect retries, compaction and cache warming. Speed and priority processing are not guaranteed.",
        { signal: preparation.abortController.signal },
      );
      if (!this.canApplyPreparation(ctx, preparation) || !confirmed) return;
      const eligibility = await this.refreshEligibility(ctx, preparation, true);
      if (!this.canApplyPreparation(ctx, preparation) || eligibility !== "supported") return;
      this.rememberChoice(ctx, "on");
      this.pendingPreparation = undefined;
      this.report(ctx);
    } catch (error) {
      this.reportPreparationFailure(error, ctx, preparation);
    } finally {
      if (this.pendingPreparation === preparation) this.pendingPreparation = undefined;
    }
  }

  private async refreshEligibility(
    ctx: FastHost,
    preparation: EligibilityPreparation,
    force: boolean,
  ): Promise<FastEligibility | undefined> {
    const signal = preparation.abortController.signal;
    const authScope = await this.readAuthScope(ctx.modelRegistry, signal);
    if (!this.canApplyPreparation(ctx, preparation)) return;
    const cached = this.cachedEligibility;
    if (
      !force &&
      cached?.modelKey === preparation.modelKey &&
      cached.authScope === authScope &&
      cached.expiresAt > this.now()
    )
      return cached.eligibility;

    this.cachedEligibility = undefined;
    this.modelTierActivity = undefined;
    if (this.now() < this.retryAt) {
      ctx.ui.notify(
        "Fast mode suspended: the catalog service is rate limited. Try again later.",
        "warning",
      );
      return;
    }
    const catalog = await this.fetchCatalog(ctx.modelRegistry, signal);
    if (!this.canApplyPreparation(ctx, preparation)) return;
    if (catalog.authScope !== authScope) {
      ctx.ui.notify(
        "Fast mode suspended: authentication changed during discovery. Try fast on again.",
        "warning",
      );
      return;
    }
    const model = ctx.model;
    if (!model) return;
    const eligibility = codexFastEligibility(catalog.data, model.id);
    this.cachedEligibility = {
      modelKey: preparation.modelKey,
      authScope,
      eligibility,
      expiresAt: this.now() + CAPABILITY_TTL_MS,
    };
    if (eligibility !== "supported") {
      ctx.ui.notify(
        `Fast mode suspended: model eligibility is ${eligibility}. Preference unchanged.`,
        "warning",
      );
    }
    return eligibility;
  }

  private startPreparation(ctx: FastHost): EligibilityPreparation {
    const model = ctx.model;
    if (!model) throw new Error("No model selected");
    const preparation: EligibilityPreparation = {
      abortController: new AbortController(),
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(),
      modelKey: modelKey(model),
      api: model.api,
      baseUrl: model.baseUrl,
    };
    this.pendingPreparation = preparation;
    return preparation;
  }

  private canApplyPreparation(ctx: FastHost, preparation: EligibilityPreparation): boolean {
    // Shutdown/cancellation can expire every host getter; check ownership before touching ctx.
    if (
      this.disposed ||
      this.pendingPreparation !== preparation ||
      preparation.abortController.signal.aborted
    )
      return false;
    const model = ctx.model;
    return (
      !!model &&
      modelKey(model) === preparation.modelKey &&
      model.api === preparation.api &&
      model.baseUrl === preparation.baseUrl &&
      ctx.isIdle() &&
      ctx.sessionManager.getSessionId() === preparation.sessionId &&
      ctx.sessionManager.getLeafId() === preparation.leafId &&
      isDirectCodexSelection(ctx)
    );
  }

  private reportPreparationFailure(
    error: unknown,
    ctx: FastHost,
    preparation: EligibilityPreparation,
  ): void {
    if (!this.canApplyPreparation(ctx, preparation)) return;
    this.cachedEligibility = undefined;
    this.modelTierActivity = undefined;
    if (error instanceof CodexAccountError && error.retryAfterMs !== undefined) {
      this.retryAt = this.now() + error.retryAfterMs;
    }
    let message = "Could not prepare Codex fast mode.";
    if (error instanceof CodexAccountError) message = error.message;
    ctx.ui.notify(`Fast mode suspended: ${message} Preference unchanged.`, "warning");
  }

  private preferenceFor(selectedModelKey: string): FastPreference {
    return this.preferences.get(selectedModelKey) ?? "inherit";
  }

  private rememberChoice(ctx: FastHost, mode: FastPreference): void {
    const model = ctx.model;
    if (!model) return;
    const selectedModelKey = modelKey(model);
    if (this.preferences.get(selectedModelKey) !== mode) {
      const choice: FastChoice = { provider: model.provider, modelId: model.id, mode };
      this.pi.appendEntry(FAST_ENTRY, choice);
      this.preferences.set(selectedModelKey, mode);
    }
    this.modelTierActivity = undefined;
  }

  private currentEligibility(selectedModelKey: string): FastEligibility {
    const cached = this.cachedEligibility;
    if (!cached || cached.modelKey !== selectedModelKey || cached.expiresAt <= this.now())
      return "unknown";
    return cached.eligibility;
  }

  private requestPolicy(ctx: FastHost): FastRequestPolicy {
    if (!ctx.model || !isDirectCodexSelection(ctx)) return "outside scope";
    const selectedModelKey = modelKey(ctx.model);
    const preference = this.preferenceFor(selectedModelKey);
    if (preference === "inherit") return "untouched";
    if (preference === "off") return "default";
    if (this.pendingPreparation || this.currentEligibility(selectedModelKey) !== "supported")
      return "suspended";
    return "priority";
  }

  private report(ctx: FastHost): void {
    const status = this.getStatus(ctx);
    if (!status) {
      ctx.ui.notify("No model selected.", "info");
      return;
    }
    const summary = formatFastStatus(status);
    const hint = `/${this.commandName} fast on|off|toggle`;
    ctx.ui.notify(`${summary}\n\n${hint}`, "info");
  }
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readObservedTier(value: unknown): ObservedTier | undefined {
  if (
    value === "priority" ||
    value === "default" ||
    value === "auto" ||
    value === "flex" ||
    value === "fast"
  )
    return value;
  return undefined;
}
