import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const BASE_URL = "https://chatgpt.com/backend-api";

type RequestRegistry = Pick<
  ExtensionContext["modelRegistry"],
  "isUsingOAuth" | "getRegisteredProviderConfig" | "getRegisteredNativeProvider"
> & {
  getProvider(id: string): Pick<Provider, "baseUrl"> | undefined;
};

export interface DirectCodexHost {
  readonly model: Model<Api> | undefined;
  readonly modelRegistry: RequestRegistry;
}

// Pi exposes the selection, not physical request identity; this only checks direct-selection scope.
export function matchesDirectCodexSelection(
  payload: unknown,
  ctx: DirectCodexHost,
): payload is Record<string, unknown> {
  const model = ctx.model;
  if (!model || model.provider !== PROVIDER || model.api !== "openai-codex-responses") return false;
  if (!officialBase(model.baseUrl)) return false;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (!("model" in payload) || payload.model !== model.id) return false;

  const registry = ctx.modelRegistry;
  if (!officialBase(registry.getProvider(PROVIDER)?.baseUrl)) return false;
  if (registry.getRegisteredProviderConfig(PROVIDER) !== undefined) return false;
  if (registry.getRegisteredNativeProvider(PROVIDER) !== undefined) return false;
  return registry.isUsingOAuth(model);
}

function officialBase(url: string | undefined): boolean {
  return url?.replace(/\/+$/, "") === BASE_URL;
}
