import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

export type ThemeLike = Pick<Theme, "fg" | "bold">;

const COLORS = {
  off: "dim",
  minimal: "muted",
  low: "success",
  medium: "accent",
  high: "warning",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
} as const;

export function styleThinking(
  theme: ThemeLike,
  level: ExtensionContext["thinkingLevel"],
  text: string,
): string {
  const color = typeof level === "string" && Object.hasOwn(COLORS, level) ? COLORS[level] : "dim";
  const styled = theme.fg(color, text);
  return level === "off" || level === "minimal" || level === undefined
    ? styled
    : theme.bold(styled);
}
