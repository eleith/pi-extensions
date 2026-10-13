import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { LIMITS } from "./core/limits.ts";
import { executeFetch, validateInput } from "./core/fetch.ts";
import { executeBatch } from "./core/batch.ts";
import { vi } from "vitest";
import { batchSchema, fetchSchema, isBatchInput, isFetchInput } from "./schema.ts";

function validate(parameters: typeof fetchSchema | typeof batchSchema, args: unknown) {
  return validateToolArguments(
    { name: "test", description: "test", parameters },
    { type: "toolCall", id: "test", name: "test", arguments: args as JsonObject },
  );
}
it("uses exact bounded host schemas, with optional controls and shared batch items", () => {
  expect(Object.keys(fetchSchema.properties)).toEqual([
    "url",
    "format",
    "maxChars",
    "timeoutMs",
    "removeImages",
    "includeReplies",
  ]);
  expect(fetchSchema).toMatchObject({ additionalProperties: false });
  expect(batchSchema).toMatchObject({ additionalProperties: false });
  expect(batchSchema.properties.requests.items).toBe(fetchSchema);
  expect(batchSchema.properties.requests).toMatchObject({ maxItems: 24 });
  expect(fetchSchema.properties.maxChars).toMatchObject({ default: LIMITS.defaultMaxChars });
  expect(fetchSchema.properties.timeoutMs).toMatchObject({ default: LIMITS.defaultTimeoutMs });
  expect(validate(fetchSchema, { url: "https://example.test" })).toEqual({
    url: "https://example.test",
  });
  for (const format of ["markdown", "html", "json", "raw"]) {
    const args = {
      url: "https://example.test",
      format,
      maxChars: LIMITS.maxChars,
      timeoutMs: LIMITS.maxTimeoutMs,
      removeImages: true,
      includeReplies: "extractors",
    };
    expect(validate(fetchSchema, args)).toEqual(args);
    expect(isFetchInput(args)).toBe(true);
  }
  expect(isFetchInput({ url: "http://localhost:1234", includeReplies: false })).toBe(true);
});
it.each(["headers", "browser", "os", "proxy", "verbose", "config"])(
  "rejects removed %s in both tools",
  (key) => {
    const args = { url: "https://example.test", [key]: "secret" };
    expect(() => validate(fetchSchema, args)).toThrow();
    expect(() => validate(batchSchema, { requests: [args] })).toThrow();
    expect(isFetchInput(args)).toBe(false);
    expect(isBatchInput({ requests: [args] })).toBe(false);
  },
);
it.each([
  {},
  null,
  [],
  "bad",
  { url: "" },
  { url: "x".repeat(LIMITS.maxUrlChars + 1) },
  { url: "https://example.test", format: "pdf" },
  { url: "https://example.test", format: "text" },
  { url: "https://example.test", maxChars: 0 },
  { url: "https://example.test", maxChars: LIMITS.maxChars + 1 },
  { url: "https://example.test", timeoutMs: 0 },
  { url: "https://example.test", timeoutMs: LIMITS.maxTimeoutMs + 1 },
  { url: "https://example.test", includeReplies: "all" },
])("rejects malformed arguments %j", (args) => {
  expect(() => validate(fetchSchema, args)).toThrow();
  expect(isFetchInput(args)).toBe(false);
});
it("rejects extra arguments in the actual core entry points before creating a network owner", async () => {
  const createOwner = vi.fn(() => {
    throw Error("Network must not start");
  });
  const input = { url: "https://example.test", headers: { Authorization: "fixture-secret" } };
  const single = await executeFetch(input, {}, { createOwner });
  expect(single).toMatchObject({ kind: "error", code: "invalid_request" });
  expect(createOwner).not.toHaveBeenCalled();
  const batch = await executeBatch([input]);
  expect(batch).toMatchObject({
    kind: "batch",
    failed: 1,
    items: [{ kind: "error", code: "invalid_request" }],
  });
});

it("shares initial input rules/defaults without mutating caller arguments or weakening batch item failures", () => {
  const input = {
    url: "https://Example.test/Path?Case=Mixed",
    format: "raw" as const,
    maxChars: 100,
    includeReplies: false,
  };
  const original = { ...input };
  expect(isFetchInput(input)).toBe(true);
  expect(validateInput(input)).toEqual({
    url: "https://example.test/Path?Case=Mixed",
    format: "raw",
    maxChars: 100,
    timeoutMs: 15000,
    removeImages: false,
    includeReplies: false,
  });
  expect(input).toEqual(original);
  for (const invalid of [
    { url: "https://example.test", format: null },
    { url: "https://example.test", timeoutMs: null },
    { url: "https://example.test", maxChars: 1.5 },
    { url: "https://example.test", removeImages: null },
    { url: "https://example.test/" + "界".repeat(4000) },
  ]) {
    expect(isFetchInput(invalid)).toBe(false);
    expect(() => validateInput(invalid)).toThrow();
  }
  const malformedDestination = { url: "not a URL" };
  expect(isFetchInput(malformedDestination)).toBe(false);
  expect(() => validateInput(malformedDestination)).toThrow();
  expect(isBatchInput({ requests: [input, malformedDestination] })).toBe(true);
});

it("revalidates destination and normalized types without adding compatibility aliases", () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.test",
    "https://user:password@example.test",
    "not a URL",
  ])
    expect(isFetchInput({ url })).toBe(false);
  for (const args of [
    { maxChars: "12" },
    { maxChars: 1.2 },
    { removeImages: "true" },
    { timeoutMs: Infinity },
    { includeReplies: null },
  ])
    expect(isFetchInput({ url: "https://example.test", ...args })).toBe(false);
  for (const requests of [
    [],
    Array.from({ length: 25 }, () => ({ url: "https://example.test" })),
  ]) {
    expect(isBatchInput({ requests })).toBe(false);
    expect(() => validate(batchSchema, { requests })).toThrow();
  }
  expect(isBatchInput({ requests: [{ url: "https://example.test" }], verbose: false })).toBe(false);
});
