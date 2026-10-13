import { expect, it } from "vitest";
import { limitContent } from "./format.ts";

it("reserves Markdown truncation notices and does not split a UTF-16 pair", () => {
  expect(limitContent("abc😀def", 4, "raw")).toMatchObject({ content: "abc", truncated: true });
  expect(limitContent("x".repeat(100), 24, "markdown").content.length).toBeLessThanOrEqual(24);
  expect(limitContent("abc", 0, "json")).toMatchObject({ content: "", truncated: true });
  expect(limitContent("abc", undefined, "raw")).toMatchObject({
    content: "abc",
    truncated: false,
    warnings: [],
  });
});
