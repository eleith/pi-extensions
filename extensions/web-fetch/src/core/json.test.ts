import { afterEach, expect, it, vi } from "vitest";
import { extractContent } from "./extract.ts";

const url = "https://example.test/data";
const noNetwork: typeof fetch = async () => {
  throw new Error("Unexpected network");
};
afterEach(() => vi.restoreAllMocks());

it("validates deeply nested JSON without serializing or expanding it", async () => {
  const source = '{"nested":'.repeat(2000) + "0" + "}".repeat(2000);
  const stringify = vi.spyOn(JSON, "stringify");
  const result = await extractContent(
    source,
    url,
    { url, format: "json", maxChars: 100 },
    noNetwork,
    undefined,
    "application/json",
  );
  expect(result.content).toBe(source.slice(0, 100));
  expect(result.truncated).toBe(true);
  expect(result.warnings).toEqual([
    "Content truncated to maxChars; this is a partial body, not necessarily valid serialized data.",
  ]);
  expect(stringify).not.toHaveBeenCalled();
});

it("preserves source whitespace, large integers, duplicate keys and number literals", async () => {
  const source = ' \n{ "id":9007199254740993, "duplicate":1, "duplicate":2, "number":1e20 }\n ';
  const result = await extractContent(
    source,
    url,
    { url, format: "json" },
    noNetwork,
    undefined,
    "application/json",
  );
  expect(result.content).toBe(source);
  expect(result.truncated).toBe(false);
  expect(result.warnings).toEqual([]);
});

it("wraps JSON source for Markdown without changing payload characters", async () => {
  const source = '{"escaped":"\\u0061","integer":9007199254740993}';
  const result = await extractContent(
    source,
    url,
    { url },
    noNetwork,
    undefined,
    "application/json",
  );
  expect(result.content).toBe(`\`\`\`json\n${source}\n\`\`\``);
});

it("normalizes an optional decoded BOM for validation without reformatting the JSON body", async () => {
  const source = ' {"id":9007199254740993} ';
  const result = await extractContent(
    "\uFEFF" + source,
    url,
    { url, format: "json" },
    noNetwork,
    undefined,
    "application/json",
  );
  expect(result.content).toBe(source);
});

it("still rejects malformed JSON instead of labeling arbitrary text JSON", async () => {
  for (const source of ['{"broken":', "[[".repeat(100)]) {
    await expect(
      extractContent(
        source,
        url,
        { url, format: "json" },
        noNetwork,
        undefined,
        "application/json",
      ),
    ).rejects.toThrow("valid JSON");
  }
});
