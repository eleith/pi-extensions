import type { Theme } from "@earendil-works/pi-coding-agent";

/** Keep the framed previews short without truncating the expanded result. */
export function previewLines<T>(
  lines: T[],
  expanded: boolean,
  limit: number,
): { shown: T[]; hidden: number } {
  const shown = expanded ? lines : lines.slice(0, limit);
  return { shown, hidden: lines.length - shown.length };
}

export function moreLines(hidden: number, theme: Theme, noun = "lines"): string {
  return theme.fg("muted", `… ${hidden} more ${noun} (expand tool output to view)`);
}
