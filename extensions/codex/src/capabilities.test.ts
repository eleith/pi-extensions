import { expect, it } from "vitest";
import { codexFastEligibility } from "./capabilities.ts";

const modelId = "future-codex-model";

it.each(["priority", "fast"])(
  "recognizes the advertised %s service tier without guessing model names",
  (id) => {
    const catalog = { models: [{ slug: modelId, service_tiers: [{ id }] }] };
    expect(codexFastEligibility(catalog, modelId)).toBe("supported");
  },
);

it("supports the legacy fast advertisement even alongside an empty newer field", () => {
  const catalog = {
    models: [{ slug: modelId, service_tiers: [], additional_speed_tiers: ["fast"] }],
  };
  expect(codexFastEligibility(catalog, modelId)).toBe("supported");
});

it("accepts legacy-only catalogs", () => {
  const catalog = { models: [{ slug: modelId, additional_speed_tiers: ["fast"] }] };
  expect(codexFastEligibility(catalog, modelId)).toBe("supported");
});

it.each([
  { service_tiers: [] },
  { service_tiers: [{ id: "default" }, { id: "ultrafast" }] },
  { additional_speed_tiers: [] },
])("distinguishes a valid list without fast mode from unknown metadata: %j", (metadata) => {
  expect(codexFastEligibility({ models: [{ slug: modelId, ...metadata }] }, modelId)).toBe(
    "unsupported",
  );
});

it.each([
  {},
  { default_service_tier: "priority" },
  { service_tiers: ["priority"] },
  { service_tiers: [{ id: "priority" }, null] },
  { service_tiers: [], additional_speed_tiers: ["fast", null] },
  { service_tiers: [{ id: "priority" }], additional_speed_tiers: ["fast", null] },
  { service_tiers: [null], additional_speed_tiers: ["fast"] },
])("does not infer eligibility from missing or malformed fields: %j", (metadata) => {
  expect(codexFastEligibility({ models: [{ slug: modelId, ...metadata }] }, modelId)).toBe(
    "unknown",
  );
});

it("does not apply another model's capability to the selected model", () => {
  const catalog = {
    models: [
      { slug: "other-model", service_tiers: [{ id: "priority" }] },
      { slug: modelId, service_tiers: [] },
    ],
  };
  expect(codexFastEligibility(catalog, modelId)).toBe("unsupported");
  expect(codexFastEligibility(catalog, "missing-model")).toBe("unknown");
});

it("treats duplicate model entries as ambiguous", () => {
  const entry = { slug: modelId, service_tiers: [{ id: "priority" }] };
  expect(codexFastEligibility({ models: [entry, entry] }, modelId)).toBe("unknown");
});

it.each([
  null,
  [],
  {},
  { models: {} },
  { models: [{ id: modelId, service_tiers: [{ id: "priority" }] }] },
])("keeps unrecognized catalog schemas unknown: %j", (catalog) => {
  expect(codexFastEligibility(catalog, modelId)).toBe("unknown");
});
