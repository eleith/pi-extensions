import type { Api, Model } from "@earendil-works/pi-ai";

export interface ContextProfile {
  readonly extendedWindow: number;
  readonly source: string;
}

// Keep room for the full 128K output allowance within the documented 1.05M total.
// These are local windows, not a claim about any account's Codex server limit.
const PROFILES: Readonly<Record<string, ContextProfile>> = {
  "openai-codex/gpt-6-sol": {
    extendedWindow: 922_000,
    source: "https://developers.openai.com/api/docs/models/gpt-6-sol",
  },
  "openai-codex/gpt-6.1-sol": {
    extendedWindow: 922_000,
    source: "https://developers.openai.com/api/docs/models/gpt-6-sol",
  },
  "openai-codex/gpt-6-astra": {
    extendedWindow: 922_000,
    source: "https://developers.openai.com/api/docs/models/gpt-6-astra",
  },
};

export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function contextProfile(model: Model<Api> | undefined): ContextProfile | undefined {
  return model ? PROFILES[modelKey(model)] : undefined;
}
