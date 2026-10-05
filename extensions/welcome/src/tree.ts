import { PALETTE, SMALL_TREE, TINY_TREE, TREE } from "./tree-data.ts";

function color(key: string): string | undefined {
  return PALETTE[key]
    ?.slice(1)
    .match(/../g)
    ?.map((part) => parseInt(part, 16))
    .join(";");
}

function halfBlock(top: string, bottom: string): string {
  if (top === "." && bottom === ".") return " ";
  if (top === bottom) return `\x1b[38;2;${color(top)}m█\x1b[0m`;
  if (bottom === ".") return `\x1b[38;2;${color(top)}m▀\x1b[0m`;
  if (top === ".") return `\x1b[38;2;${color(bottom)}m▄\x1b[0m`;
  return `\x1b[38;2;${color(top)};48;2;${color(bottom)}m▀\x1b[0m`;
}

/** Each Unicode half-block is one terminal column and two colored vertical pixels. */
export function coloredTree(rows: readonly string[]): string[] {
  const result: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    const upper = rows[y] ?? "";
    const lower = rows[y + 1] ?? "";
    let line = "";
    for (let x = 0; x < upper.length; x++) {
      line += halfBlock(upper[x] ?? ".", lower[x] ?? ".");
    }
    result.push(line.trimEnd());
  }
  return result;
}

export interface TreeVariant {
  readonly lines: readonly string[];
  readonly width: number;
}

export const treeVariants = {
  large: { lines: coloredTree(TREE), width: 48 },
  small: { lines: coloredTree(SMALL_TREE), width: 30 },
  tiny: { lines: coloredTree(TINY_TREE), width: 20 },
} as const;
