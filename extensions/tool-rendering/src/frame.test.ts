import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import {
  builtinContext,
  frameComponent,
  frameTop,
  frameBottomWithLabel,
  frameToolError,
  frameStatus,
  resultLabel,
  formatDuration,
} from "./frame.ts";
import { previewLines } from "./preview.ts";
import { normalizeLineEndings, textFromResult } from "./tool-result.ts";

const theme = {
  fg: (_token: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

it("fits top and bottom labels to the available columns, not string length", () => {
  for (const width of [1, 2, 5, 6, 10, 20, 80, 120]) {
    for (const line of [
      frameTop(theme.fg("accent", "模型🧠e\u0301".repeat(20)), "pending", theme, width),
      frameBottomWithLabel("模型🧠".repeat(20), "error", theme, width),
    ]) {
      expect(visibleWidth(line)).toBe(width);
    }
  }
});

it("uses actual component width again after resize, with a 210-column cap", () => {
  const component = frameComponent({ lastComponent: undefined }, (width) =>
    frameTop("read", "success", theme, width),
  );
  for (const width of [120, 15, 80, 250])
    expect(visibleWidth(stripTerminalSequences(component.render(width)[0]).trimEnd())).toBe(
      Math.min(width, 210),
    );
  expect(
    frameComponent({ lastComponent: component }, (width) =>
      frameTop("write", "pending", theme, width),
    ),
  ).toBe(component);
  expect(stripTerminalSequences(component.render(80)[0])).toContain("write");
});

it("contains painter failures outside Pi's renderer callback guard", () => {
  const component = frameComponent({ lastComponent: undefined }, () => {
    throw new Error("Malformed streamed arguments");
  });
  expect(() => component.render(20)).not.toThrow();
  expect(component.render(80).join("\n")).toContain("could not be rendered");
  for (const line of component.render(5)) expect(visibleWidth(line)).toBeLessThanOrEqual(5);
});

it("never lends a FramedText painter to a builtin renderer", () => {
  const component = frameComponent({ lastComponent: undefined }, () => "custom");
  const ctx = { lastComponent: component, args: { path: "a" } };
  expect(builtinContext(ctx)).toEqual({ ...ctx, lastComponent: undefined });
  const native = { lastComponent: new Text("native", 0, 0) };
  expect(builtinContext(native)).toBe(native);
});

it("errors take precedence over partial state, and collapsed errors show five lines", () => {
  expect(frameStatus({ isError: true, isPartial: true })).toBe("error");
  expect(frameStatus({ isPartial: true })).toBe("pending");
  expect(frameStatus({})).toBe("success");
  const message = Array.from({ length: 7 }, (_, i) => `error${i}`).join("\n");
  const collapsed = stripTerminalSequences(frameToolError(message, false, theme, 80));
  expect(collapsed).toContain("error4");
  expect(collapsed).not.toContain("error5");
  expect(collapsed).toContain("2 hidden");
  expect(stripTerminalSequences(frameToolError(message, true, theme, 80))).toContain("error6");
});

it("records hidden lines without adding a notice to expanded output", () => {
  expect(previewLines([1, 2, 3], false, 2)).toEqual({ shown: [1, 2], hidden: 1 });
  expect(previewLines([1, 2, 3], true, 2)).toEqual({ shown: [1, 2, 3], hidden: 0 });
  expect(stripTerminalSequences(resultLabel("3 lines", false, 1, theme))).toBe(
    "3 lines · collapsed · 1 hidden",
  );
});

it.each([
  [0, "0.0s"],
  [1234, "1.2s"],
  [60000, "1m"],
  [61000, "1m1s"],
  [3600000, "1h"],
  [3660000, "1h1m"],
])("formats duration %s", (ms, label) => {
  expect(formatDuration(ms as number)).toBe(label);
});

it("extracts text without image data and normalizes CRLF and bare carriage returns", () => {
  expect(
    textFromResult({
      content: [
        { type: "text", text: "one" },
        { type: "image", data: "not text", mimeType: "image/png" },
        { type: "text", text: "two" },
      ],
      details: undefined,
    }),
  ).toBe("one\ntwo");
  expect(normalizeLineEndings("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
});
