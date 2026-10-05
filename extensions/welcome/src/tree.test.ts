import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { PALETTE, SMALL_TREE, TINY_TREE, TREE } from "./tree-data.ts";
import { coloredTree, treeVariants } from "./tree.ts";

const rgb = (hex: string) =>
  hex
    .slice(1)
    .match(/../g)!
    .map((part) => parseInt(part, 16))
    .join(";");

describe("coloredTree", () => {
  it("preserves transparent, solid, upper, lower, and two-color pixels byte for byte", () => {
    expect(coloredTree([".AAA.", "..ABS"])).toEqual([
      " " +
        "\x1b[38;2;42;107;115m▀\x1b[0m" +
        "\x1b[38;2;42;107;115m█\x1b[0m" +
        "\x1b[38;2;42;107;115;48;2;54;128;123m▀\x1b[0m" +
        "\x1b[38;2;212;93;90m▄\x1b[0m",
    ]);
  });

  it("renders every palette entry in truecolor and resets each pixel", () => {
    for (const [key, hex] of Object.entries(PALETTE)) {
      expect(coloredTree([key, key])).toEqual([`\x1b[38;2;${rgb(hex)}m█\x1b[0m`]);
    }
  });

  it("handles an unpaired final row and trims only trailing transparent cells", () => {
    expect(coloredTree(["..S.."]).map(stripTerminalSequences)).toEqual(["  ▀"]);
    expect(coloredTree(["...", "..."])).toEqual([""]);
    expect(coloredTree([])).toEqual([]);
    const rows = [".S.", ".S."];
    const first = coloredTree(rows);
    first[0] = "modified";
    expect(coloredTree(rows)).not.toEqual(first);
    expect(rows).toEqual([".S.", ".S."]);
  });
});

describe("original artwork variants", () => {
  it.each([
    ["large", TREE, 48, 22],
    ["small", SMALL_TREE, 30, 14],
    ["tiny", TINY_TREE, 20, 10],
  ] as const)("%s keeps its original dimensions and palette", (size, rows, width, height) => {
    const variant = treeVariants[size];
    expect(variant.width).toBe(width);
    expect(variant.lines).toHaveLength(height);
    expect(variant.lines).toEqual(coloredTree(rows));
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(width);
      for (const pixel of row) expect(pixel === "." || pixel in PALETTE).toBe(true);
    }
    for (const line of variant.lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(stripTerminalSequences(line)).toMatch(/^[ █▀▄]*$/u);
      // ANSI foreground/background values must belong to the original palette.
      for (const match of line.matchAll(/(?:38|48);2;(\d+;\d+;\d+)/g)) {
        expect(Object.values(PALETTE).map(rgb)).toContain(match[1]);
      }
    }
    expect(variant.lines.join("\n")).toContain("212;93;90"); // π fruit
  });
});
