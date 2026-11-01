type CatalogModel = Record<string, unknown>;
export type FastEligibility = "supported" | "unsupported" | "unknown";

export function codexFastEligibility(catalog: unknown, modelId: string): FastEligibility {
  const model = findCatalogModel(catalog, modelId);
  if (!model) return "unknown";

  const serviceTierSupport = readServiceTierSupport(model.service_tiers);
  const legacyTierSupport = readLegacyTierSupport(model.additional_speed_tiers);
  const invalidServiceTiers = "service_tiers" in model && serviceTierSupport === undefined;
  const invalidLegacyTiers = "additional_speed_tiers" in model && legacyTierSupport === undefined;
  if (invalidServiceTiers || invalidLegacyTiers) return "unknown";

  if (serviceTierSupport === true || legacyTierSupport === true) return "supported";
  if (serviceTierSupport === false || legacyTierSupport === false) return "unsupported";
  return "unknown";
}

function findCatalogModel(catalog: unknown, modelId: string): CatalogModel | undefined {
  if (!modelId) return undefined;
  const models = readObject(catalog)?.models;
  if (!Array.isArray(models)) return undefined;

  let matched: CatalogModel | undefined;
  for (const value of models) {
    const model = readObject(value);
    if (model?.slug !== modelId) continue;
    if (matched) return undefined;
    matched = model;
  }
  return matched;
}

function readServiceTierSupport(value: unknown): boolean | undefined {
  if (!Array.isArray(value)) return undefined;
  let supported = false;
  for (const item of value) {
    const tier = readObject(item);
    if (typeof tier?.id !== "string" || !tier.id.trim()) return undefined;
    if (tier.id === "priority" || tier.id === "fast") supported = true;
  }
  return supported;
}

function readLegacyTierSupport(value: unknown): boolean | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((tier) => typeof tier === "string" && tier.trim().length > 0)) return undefined;
  return value.includes("fast");
}

function readObject(value: unknown): CatalogModel | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as CatalogModel)
    : undefined;
}
