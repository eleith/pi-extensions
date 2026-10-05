import { VERSION, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { styleThinking } from "@eleith/pi-internal/thinking";
import { safe } from "./format.ts";
import { treeVariants, type TreeVariant } from "./tree.ts";
import type { TreeSize, WelcomeData } from "./types.ts";

const GAP = 3;
const PAD = 2;
const EDGE = " ".repeat(PAD);
const MIN_INFO_WIDTH = 40;
type CardTheme = Pick<Theme, "fg" | "bold">;

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width), "…");
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Persisted entries may predate treeSize or contain an unrecognized preference. */
function selectTree(size: TreeSize | undefined, usable: number): TreeVariant | undefined {
  const preferred =
    size === "large" || size === "small" || size === "tiny" ? treeVariants[size] : undefined;
  if (preferred && preferred.width <= usable) return preferred;
  if (usable >= treeVariants.large.width + GAP + MIN_INFO_WIDTH) return treeVariants.large;
  if (usable >= treeVariants.small.width) return treeVariants.small;
  if (usable >= treeVariants.tiny.width) return treeVariants.tiny;
  return undefined;
}

function thinkingLevel(value: unknown): NonNullable<WelcomeData["thinking"]> {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return "off";
  }
}

function contextSuffix(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? `  ·  ${Math.round(value / 1000)}k context`
    : "";
}

export class WelcomeCard implements Component {
  constructor(
    private readonly data: WelcomeData,
    private readonly theme: CardTheme,
  ) {}

  render(width: number): string[] {
    const w = Math.max(1, width);
    if (w < PAD * 2 + 1) return [truncateToWidth(this.theme.fg("accent", "pi"), w, "")];

    const usable = w - PAD * 2;
    const detail = this.details();
    const tree = selectTree(this.data.treeSize, usable);
    const body =
      tree && usable >= tree.width + GAP + MIN_INFO_WIDTH
        ? this.sideBySide(tree, detail, usable)
        : this.stacked(tree, detail, w, usable);
    return [this.topBorder(w), "", ...body, "", this.theme.fg("borderAccent", "─".repeat(w))];
  }

  private heading(text: string): string {
    return this.theme.fg("mdHeading", `[ ${text} ]`);
  }

  private fact(label: string, value: unknown): string {
    const text = safe(value);
    return (
      this.theme.fg("muted", label.padEnd(9)) +
      this.theme.fg("text", text === "—" ? "0 found" : text)
    );
  }

  private workspaceInfo(): string {
    const session = safe(this.data.session);
    // Match nono's own indicator, without inspecting its capability file or status bus.
    const sandboxed = Boolean(process.env.NONO_CAP_FILE);
    return [
      safe(this.data.branch),
      sandboxed ? "nono sandbox" : "",
      ["new session", "unnamed session"].includes(session) ? "" : session,
    ]
      .filter(Boolean)
      .join("  ·  ");
  }

  private details(): string[] {
    const t = this.theme;
    const workspaceInfo = this.workspaceInfo();
    const thinking = thinkingLevel(this.data.thinking);
    return [
      this.heading("Workspace"),
      t.fg("text", safe(this.data.directory)),
      ...(workspaceInfo ? [t.fg("muted", workspaceInfo)] : []),
      "",
      this.heading("Provider"),
      t.fg("text", safe(this.data.model)),
      styleThinking(t, thinking, thinking) +
        t.fg("muted", ` thinking${contextSuffix(this.data.contextWindow)}`),
      "",
      this.heading("Resources"),
      this.fact("Agents", this.data.context),
      this.fact("Skills", this.data.skills),
      this.fact("Prompts", this.data.prompts),
      this.fact("Tools", this.data.tools),
      "",
      t.fg("dim", "Type / for commands  ·  ! for shell"),
    ];
  }

  private topBorder(width: number): string {
    const t = this.theme;
    const title = ` pi / v${VERSION} `;
    const shortTitle = " pi ";
    const label =
      width >= visibleWidth(title) + 4
        ? title
        : width >= visibleWidth(shortTitle) + 2
          ? shortTitle
          : "";
    const leftRule = label ? 2 : 0;
    return (
      t.fg("borderAccent", "─".repeat(leftRule)) +
      t.bold(t.fg("accent", label)) +
      t.fg("borderAccent", "─".repeat(width - leftRule - visibleWidth(label)))
    );
  }

  private sideBySide(tree: TreeVariant, detail: readonly string[], usable: number): string[] {
    const infoWidth = usable - tree.width - GAP;
    const height = Math.max(tree.lines.length, detail.length);
    const treeOffset = Math.floor((height - tree.lines.length) / 2);
    const detailOffset = Math.floor((height - detail.length) / 2);
    return Array.from(
      { length: height },
      (_, row) =>
        EDGE +
        pad(tree.lines[row - treeOffset] ?? "", tree.width) +
        " ".repeat(GAP) +
        fit(detail[row - detailOffset] ?? "", infoWidth),
    );
  }

  private stacked(
    tree: TreeVariant | undefined,
    detail: readonly string[],
    width: number,
    usable: number,
  ): string[] {
    const lines: string[] = [];
    if (tree) {
      const indent = " ".repeat(Math.floor((width - tree.width) / 2));
      lines.push(...tree.lines.map((line) => indent + line), "");
    }
    lines.push(...detail.map((line) => EDGE + fit(line, usable)));
    return lines;
  }

  // Theme, entry fields, and sandbox presence are evaluated on every render; no cache to clear.
  invalidate(): void {}
}
