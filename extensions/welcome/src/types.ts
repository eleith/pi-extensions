import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ENTRY_TYPE = "eleith-startup-tree";
export type TreeSize = "auto" | "large" | "small" | "tiny";

export interface WelcomeData {
  treeSize?: TreeSize;
  directory: string;
  branch?: string;
  session: string;
  model: string;
  contextWindow?: number;
  thinking?: ExtensionContext["thinkingLevel"];
  context: string;
  skills: string;
  prompts: string;
  tools: string;
}

export type WelcomeAPI = Pick<
  ExtensionAPI,
  "appendEntry" | "getCommands" | "getAllTools" | "getActiveTools"
>;
export type WelcomeHost = Pick<ExtensionContext, "mode" | "cwd" | "model" | "thinkingLevel"> & {
  readonly sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "getSessionName" | "getSessionId" | "getLeafId" | "getEntries" | "getBranch"
  >;
};
