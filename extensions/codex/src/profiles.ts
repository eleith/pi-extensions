import type { Api, Model } from "@earendil-works/pi-ai";

export interface ContextProfile {
  readonly extendedWindow: number;
  readonly source: string;
}

// Match Codex's advertised maximum, not the direct OpenAI API input limit.
const CODEX_PROFILE: ContextProfile = Object.freeze({
  extendedWindow: 872_000,
  source: "https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/models-manager/models.json",
});

// Share verified metadata, not a naming rule: future versions need an explicit review.
const PROFILES: Readonly<Record<string, ContextProfile>> = {
  "openai-codex/gpt-6-sol": CODEX_PROFILE,
  "openai-codex/gpt-6.1-sol": CODEX_PROFILE,
  "openai-codex/gpt-6-astra": CODEX_PROFILE,
  "openai-codex/gpt-6.2-sol": CODEX_PROFILE,
  "openai-codex/gpt-6.2-astra": CODEX_PROFILE,
};

export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function contextProfile(model: Model<Api> | undefined): ContextProfile | undefined {
  if (model?.api !== "openai-codex-responses") return undefined;
  return PROFILES[modelKey(model)];
}
