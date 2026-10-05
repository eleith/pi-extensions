import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { GitStatus, ThemeLike } from "./types.ts";

const TOKEN_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 0,
});

export function styleThinking(
  theme: ThemeLike,
  level: ExtensionContext["thinkingLevel"],
  text: string,
): string {
  const color =
    level === "low"
      ? "success"
      : level === "medium"
        ? "accent"
        : level === "high"
          ? "warning"
          : level === "xhigh"
            ? "thinkingXhigh"
            : level === "max"
              ? "thinkingMax"
              : level === "minimal"
                ? "muted"
                : "dim";
  const styled = theme.fg(color, text);
  return level === "off" || level === "minimal" || level === undefined
    ? styled
    : theme.bold(styled);
}

type ModelStatusContext = Pick<ExtensionContext, "model" | "thinkingLevel" | "getContextUsage">;

export function topRightStatus(
  ctx: ModelStatusContext,
  theme: ThemeLike,
  separator: string,
  width = Infinity,
): string {
  const thinking =
    theme.fg("muted", "Thinking: ") +
    styleThinking(theme, ctx.thinkingLevel, thinkingLabel(ctx.thinkingLevel));
  const context = contextLabel(ctx, theme);
  const full = wrap(
    joinSections([theme.fg("muted", modelLabel(ctx.model)), thinking, context], separator),
  );
  if (visibleWidth(full) <= width) return full;
  const compact = wrap(joinSections([thinking, context], separator));
  return visibleWidth(compact) <= width ? compact : wrap(context);
}

export function bottomLeftStatus(
  ctx: ExtensionContext,
  statuses: ReadonlyMap<string, string> | undefined,
  gitBranch: string | null,
  gitStatus: GitStatus | null,
  theme: ThemeLike,
  separator: string,
  width = Infinity,
): string[] {
  const project = plainLabel(basename(ctx.cwd || process.cwd()));
  const extensionStatus = extensionStatusLabel(statuses);
  const gitSection = gitLabel(gitBranch, gitStatus);
  const full = wrap(joinSections([extensionStatus, project, gitSection], separator));
  if (!gitSection || visibleWidth(full) <= width) return [theme.fg("dim", full)];
  return [
    theme.fg("dim", wrap(joinSections([extensionStatus, project], separator))),
    theme.fg("dim", wrap(gitSection)),
  ];
}

export function extensionStatusLabel(statuses: ReadonlyMap<string, string> | undefined): string {
  if (!statuses || statuses.size === 0) return "";
  return [...statuses.values()].map(plainLabel).filter(Boolean).join(" › ");
}

export function contextLabel(
  ctx: Pick<ModelStatusContext, "model" | "getContextUsage">,
  theme: ThemeLike,
): string {
  const usage = ctx.getContextUsage();
  const percent = usage?.percent;
  const color =
    typeof percent !== "number" || !Number.isFinite(percent)
      ? "muted"
      : percent >= 90
        ? "error"
        : percent >= 75
          ? "warning"
          : percent >= 50
            ? "accent"
            : "muted";
  const value = `${tokenLabel(usage?.tokens)}/${tokenLabel(usage?.contextWindow ?? ctx.model?.contextWindow)}`;
  return (
    theme.fg(color, "Context: ") +
    (color === "muted" ? theme.fg(color, value) : theme.bold(theme.fg(color, value)))
  );
}

function tokenLabel(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? TOKEN_FORMAT.format(value).toLowerCase()
    : "unknown";
}

export function modelLabel(model: ExtensionContext["model"]): string {
  const label = model?.name || model?.id || "no model";
  return plainLabel(label).replace(/^gpt-/i, "GPT-");
}

export function thinkingLabel(level: ExtensionContext["thinkingLevel"]): string {
  switch (level) {
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Maximum";
    default:
      return "Off";
  }
}

export function gitLabel(branch: string | null, status: GitStatus | null): string {
  if (!branch) return "";
  const changes = status
    ? [
        status.staged > 0
          ? `${status.staged} staged ${status.staged === 1 ? "change" : "changes"}`
          : "",
        status.unstaged > 0
          ? `${status.unstaged} unstaged ${status.unstaged === 1 ? "change" : "changes"}`
          : "",
        status.untracked > 0
          ? `${status.untracked} untracked ${status.untracked === 1 ? "file" : "files"}`
          : "",
      ].filter(Boolean)
    : [];
  return (
    `Git: ${plainLabel(branch)}` +
    (status ? ` › ${changes.length ? changes.join(" › ") : "clean"}` : "")
  );
}

function joinSections(parts: readonly string[], separator: string): string {
  return parts.filter(Boolean).join(` ${separator} `);
}

function wrap(text: string): string {
  return text ? ` ${text} ` : "";
}

function plainLabel(value: string): string {
  return (
    stripTerminalSequences(value)
      // oxlint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}
