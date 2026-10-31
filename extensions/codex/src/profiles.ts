import type { Api, Model } from "@earendil-works/pi-ai";

export interface ContextProfile {
  readonly extendedWindow: number;
  readonly source: string;
}

// Keep room for the full 128K output allowance within the documented 1.05M total.
// These are local windows, not a claim about any account's Codex server limit.
const SOL_PROFILE: ContextProfile = Object.freeze({
  extendedWindow: 922_000,
  source: "https://developers.openai.com/api/docs/models/gpt-6-sol",
});
const ASTRA_PROFILE: ContextProfile = Object.freeze({
  extendedWindow: 922_000,
  source: "https://developers.openai.com/api/docs/models/gpt-6-astra",
});

// Share verified metadata, not a naming rule: future versions need an explicit review.
const PROFILES: Readonly<Record<string, ContextProfile>> = {
  "openai-codex/gpt-6-sol": SOL_PROFILE,
  "openai-codex/gpt-6.1-sol": SOL_PROFILE,
  "openai-codex/gpt-6-astra": ASTRA_PROFILE,
};

export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function contextProfile(model: Model<Api> | undefined): ContextProfile | undefined {
  if (model?.api !== "openai-codex-responses") return undefined;
  return PROFILES[modelKey(model)];
}
