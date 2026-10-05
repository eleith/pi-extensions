import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";

export interface GitStatus {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
}

export interface ChromeSnapshot {
  readonly ctx: ExtensionContext;
  readonly footerData: ReadonlyFooterDataProvider | undefined;
  readonly gitStatus: GitStatus | null;
}

export type ThemeLike = Pick<Theme, "fg" | "bold">;
