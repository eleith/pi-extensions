import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import {
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

it("reuses painting and Text layout on unchanged transcript redraws", () => {
  const painter = vi.fn((width: number) => frameTop("read", "success", theme, width));
  const component = frameComponent({ lastComponent: undefined }, painter);
  const setText = vi.spyOn(component, "setText");
  const first = component.render(80);
  for (let redraw = 0; redraw < 100; redraw++) expect(component.render(80)).toBe(first);
  expect(painter).toHaveBeenCalledTimes(1);
  expect(setText).toHaveBeenCalledTimes(1);
});

it("repaints on resize but only resets text when the painted output changes", () => {
  const painter = vi.fn((_width: number) => "unchanged");
  const component = frameComponent({ lastComponent: undefined }, painter);
  const setText = vi.spyOn(component, "setText");
  for (const width of [80, 80, 20, 20, 250, 300]) {
    expect(visibleWidth(component.render(width)[0])).toBe(width);
  }
  expect(painter.mock.calls.map(([width]) => width)).toEqual([80, 20, 210]);
  expect(setText).toHaveBeenCalledTimes(1);
});

it("rebuilds themed and mutable state on invalidate, and content on painter replacement", () => {
  let color = "\x1b[36m";
  let status = "pending";
  const painter = vi.fn(() => `${color}${status}\x1b[39m`);
  const component = frameComponent({ lastComponent: undefined }, painter);
  expect(component.render(80)[0]).toContain("\x1b[36mpending");
  color = "\x1b[31m";
  status = "error";
  component.invalidate();
  const updated = component.render(80);
  expect(updated[0]).toContain("\x1b[31merror");
  expect(component.render(80)).toBe(updated);
  expect(painter).toHaveBeenCalledTimes(2);

  const replacement = vi.fn(() => "expanded output");
  expect(frameComponent({ lastComponent: component }, replacement)).toBe(component);
  expect(component.render(80)[0]).toContain("expanded output");
  component.render(80);
  expect(replacement).toHaveBeenCalledTimes(1);
});

it("caches painting failures until invalidated and recovers on the next paint", () => {
  let failing = true;
  const painter = vi.fn(() => {
    if (failing) throw new Error("Malformed streamed arguments");
    return "recovered";
  });
  const component = frameComponent({ lastComponent: undefined }, painter);
  const fallback = component.render(80);
  expect(fallback.join("\n")).toContain("could not be rendered");
  expect(component.render(80)).toBe(fallback);
  expect(painter).toHaveBeenCalledTimes(1);
  failing = false;
  component.invalidate();
  expect(component.render(80)[0]).toContain("recovered");
  expect(painter).toHaveBeenCalledTimes(2);
});

it("contains painter failures outside Pi's renderer callback guard", () => {
  const component = frameComponent({ lastComponent: undefined }, () => {
    throw new Error("Malformed streamed arguments");
  });
  expect(() => component.render(20)).not.toThrow();
  expect(component.render(80).join("\n")).toContain("could not be rendered");
  for (const line of component.render(5)) expect(visibleWidth(line)).toBeLessThanOrEqual(5);
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
