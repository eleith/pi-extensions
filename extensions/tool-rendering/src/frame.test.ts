import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import {
  frameComponent,
  frameTop,
  frameBottomWithLabel,
  frameResultWithBottomLabel,
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

it.each([0, 1])("honors outputPad=%s within the native content width", (outputPad) => {
  const payload = "A界é🙂Z";
  const body = theme.fg("toolOutput", payload);
  const painter = vi.fn((width: number) => {
    const title = frameTop("padding", "success", theme, width);
    const result = frameResultWithBottomLabel(body, "expanded", "success", theme, width, true);
    return `${title}\n${result}`;
  });
  const component = frameComponent({ lastComponent: undefined, outputPad }, painter);
  for (const width of [1, 2, 3, 4, 5, 20, 80, 250, 3, 80]) {
    const lines = component.render(width);
    const padding = width < 3 ? 0 : outputPad;
    const contentWidth = width - padding * 2;
    const expectedWidth = Math.min(contentWidth, 210);
    const paintedWidth = painter.mock.lastCall?.[0];
    expect(paintedWidth).toBe(expectedWidth);
    const plain = lines.map((line) => stripTerminalSequences(line));
    const prefix = " ".repeat(padding);
    for (const border of [plain[0], plain.at(-1)!]) {
      const margin = border.slice(0, padding);
      expect(margin).toBe(prefix);
      const content = border.slice(padding).trimEnd();
      const columns = visibleWidth(content);
      expect(columns).toBe(expectedWidth);
    }
    const content = plain.slice(1, -1);
    const unpadded = content.map((line) => line.slice(padding).trimEnd());
    const restored = unpadded.join("");
    const expected = contentWidth === 1 ? "A…é…Z" : payload;
    expect(restored).toBe(expected);
    for (const line of lines) {
      const columns = visibleWidth(line);
      expect(columns).toBeLessThanOrEqual(width);
      if (padding) {
        const unstyled = stripTerminalSequences(line);
        const left = unstyled[0];
        const right = unstyled.at(-1);
        expect(left).toBe(" ");
        expect(right).toBe(" ");
      }
    }
    const repeated = component.render(width);
    expect(repeated).toBe(lines);
  }
});

it.each([80, 250])("updates cached padding at width %s, including capped painters", (width) => {
  const painter = vi.fn((paintWidth: number) => frameTop("padding", "success", theme, paintWidth));
  const component = frameComponent({ lastComponent: undefined, outputPad: 0 }, painter);
  const original = component.render(width);
  component.setPaddingX(1);
  const padded = component.render(width);
  const first = stripTerminalSequences(padded[0]);
  expect(first).toMatch(/^ ─/);
  const unpaddedWidth = Math.min(width, 210);
  const paddedWidth = Math.min(width - 2, 210);
  const widths = painter.mock.calls.map(([paintWidth]) => paintWidth);
  expect(widths).toEqual([unpaddedWidth, paddedWidth]);
  component.setPaddingX(1);
  const repeated = component.render(width);
  expect(repeated).toBe(padded);
  const reused = frameComponent({ lastComponent: component, outputPad: 0 }, painter);
  expect(reused).toBe(component);
  const restored = reused.render(width);
  expect(restored).toEqual(original);
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

it("clips bodies by default but wraps all expanded text, preserving styles and the frame cap", () => {
  const payload = "界🙂éabcdef".repeat(45);
  const body = theme.fg("toolOutput", payload);
  const compact = frameResultWithBottomLabel(body, "collapsed", "success", theme, 20);
  const compactLines = compact.split("\n");
  expect(compactLines).toHaveLength(2);
  const compactBody = stripTerminalSequences(compactLines[0]);
  expect(compactBody).toContain("…");
  const explicitlyCollapsed = frameResultWithBottomLabel(
    body,
    "collapsed",
    "success",
    theme,
    20,
    false,
  );
  expect(explicitlyCollapsed).toBe(compact);

  const component = frameComponent({ lastComponent: undefined }, (width) =>
    frameResultWithBottomLabel(body, "expanded", "success", theme, width, true),
  );
  for (const width of [2, 5, 20, 80, 250, 20]) {
    const lines = component.render(width);
    const content = lines.slice(0, -1);
    const unstyled = content.map((line) => stripTerminalSequences(line));
    const restored = unstyled.map((line) => line.trimEnd()).join("");
    expect(restored).toBe(payload);
    const cap = Math.min(width, 210);
    for (const line of lines) {
      const plain = stripTerminalSequences(line);
      const unpadded = plain.trimEnd();
      const columns = visibleWidth(unpadded);
      expect(columns).toBeLessThanOrEqual(cap);
    }
    for (const line of content) expect(line).toContain("\x1b[36m");
    const repeated = component.render(width);
    expect(repeated).toBe(lines);
  }
});

it("retains narrow glyphs and marks wide glyphs that cannot fit in one column", () => {
  const body = theme.fg("toolOutput", "A界é🙂Z");
  const component = frameComponent({ lastComponent: undefined }, (width) =>
    frameResultWithBottomLabel(body, "expanded", "success", theme, width, true),
  );
  const narrow = component.render(1);
  const content = narrow.slice(0, -1);
  const plain = content.map((line) => stripTerminalSequences(line));
  const restored = plain.map((line) => line.trimEnd()).join("");
  expect(restored).toBe("A…é…Z");
  for (const line of narrow) {
    const columns = visibleWidth(line);
    expect(columns).toBeLessThanOrEqual(1);
  }
});

it("preserves explicit blank lines when wrapping an expanded body", () => {
  const body = "first\n\nlast\n";
  const frame = frameResultWithBottomLabel(body, "expanded", "success", theme, 40, true);
  const lines = frame.split("\n");
  const content = lines.slice(0, -1);
  const restored = content.join("\n");
  expect(restored).toBe(body);
  expect(lines).toHaveLength(5);
});

it("wraps expanded errors while counting hidden logical lines in compact errors", () => {
  const first = "failure".repeat(40);
  const message = `${first}\nsecond\nthird\nfourth\nfifth\nsixth\nseventh`;
  const compact = frameToolError(message, false, theme, 80);
  const compactLines = compact.split("\n");
  expect(compactLines).toHaveLength(6);
  const compactText = stripTerminalSequences(compact);
  expect(compactText).toContain("2 hidden");
  const expanded = frameToolError(message, true, theme, 40);
  const expandedLines = expanded.split("\n");
  const content = expandedLines.slice(0, -1);
  const restored = content.map((line) => stripTerminalSequences(line)).join("");
  const expected = message.replace(/\n/g, "");
  expect(restored).toBe(expected);
  for (const line of content) expect(line).toContain("\x1b[36m");
  const footer = expandedLines.at(-1)!;
  const plainFooter = stripTerminalSequences(footer);
  expect(plainFooter).toContain("✗ error · expanded");
  expect(plainFooter).not.toContain("hidden");
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
