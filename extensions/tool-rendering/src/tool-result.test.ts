import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { rawTextFromResult, sanitizeDisplayText, textFromResult } from "./tool-result.ts";

it.each([
  ["SGR styles", "\x1b[31mvisible\x1b[0m"],
  ["cursor controls", "\x1b[2J\x1b[Hvisible\x1b[?25l"],
  ["BEL-terminated hyperlinks", "\x1b]8;;https://private.test\x07visible\x1b]8;;\x07"],
  ["ST-terminated hyperlinks", "\x1b]8;;https://private.test\x1b\\visible\x1b]8;;\x1b\\"],
  ["clipboard commands", "\x1b]52;c;cHJpdmF0ZQ==\x07visible"],
  ["title commands", "\x1b]0;private title\x1b\\visible"],
  ["APC commands", "\x1b_private payload\x1b\\visible"],
  ["C1 OSC strings", "\x9d0;private title\x9cvisible"],
  ["C1 APC strings", "\x9fprivate payload\x9cvisible"],
  ["binary controls", "\x00\x01\x07\x08\x0b\x0c\x1f\x7f\x85\x9evisible"],
  ["interlinear annotations", "\ufff9\ufffa\ufffbvisible"],
  ["unterminated escape", "visible\x1b"],
  ["unterminated OSC string", "visible\x1b]private payload"],
  ["unterminated APC string", "visible\x1b_private payload"],
])("removes %s before display", (_kind, input) => {
  const actual = sanitizeDisplayText(input);
  expect(actual).toBe("visible");
});

it("preserves visible text following cursor-visibility controls", () => {
  const actual = sanitizeDisplayText("\x1b[?25lvisible\nmore output");
  expect(actual).toBe("visible\nmore output");
});

it("bounds malformed-sequence handling without blocking the test runner", () => {
  const moduleUrl = new URL("./tool-result.ts", import.meta.url);
  const moduleSpecifier = JSON.stringify(moduleUrl.href);
  const script = `
    import assert from "node:assert/strict";
    import { sanitizeDisplayText } from ${moduleSpecifier};
    for (const token of ["\\x1b]", "\\x1b_"]) {
      const input = token.repeat(50_000);
      const unterminated = sanitizeDisplayText(input);
      assert.equal(unterminated, "");
      const terminated = input + "\\x07visible";
      const result = sanitizeDisplayText(terminated);
      assert.equal(result, "visible");
    }
    const csi = "\\x1b[".repeat(50_000);
    const result = sanitizeDisplayText(csi);
    const hasEscape = result.includes("\\x1b");
    assert.equal(hasEscape, false);
    console.log("ok");
  `;
  // A subprocess deadline catches synchronous stalls in sanitation code or the Node helper.
  const output = execFileSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 1024 },
  );
  const status = output.trim();
  expect(status).toBe("ok");
});

it("preserves ordinary Unicode, spaces, tabs, and line endings", () => {
  const text = "  中文 👩‍💻 é\tvalue\r\nnext\rline\n";
  const actual = sanitizeDisplayText(text);
  expect(actual).toBe(text);
});

it("sanitizes text blocks without changing model-facing results or image data", () => {
  const result = {
    content: [
      { type: "text" as const, text: "\x1b[31mone\x1b[0m" },
      { type: "image" as const, data: "unchanged-image-data", mimeType: "image/png" },
      { type: "text" as const, text: "\x1b]52;c;private\x07two\x00" },
    ],
    details: { raw: "\x1b[31mkeep stored details\x1b[0m" },
    structuredContent: { raw: "\x1b[31mkeep structured data\x1b[0m" },
  };
  const original = structuredClone(result);
  Object.freeze(result);
  Object.freeze(result.content);
  for (const item of result.content) Object.freeze(item);
  Object.freeze(result.details);
  Object.freeze(result.structuredContent);
  const raw = rawTextFromResult(result);
  expect(raw).toBe("\x1b[31mone\x1b[0m\n\x1b]52;c;private\x07two\x00");
  const actual = textFromResult(result);
  expect(actual).toBe("one\ntwo");
  expect(result).toEqual(original);
});
