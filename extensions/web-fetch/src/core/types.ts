export const FORMATS = ["markdown", "html", "json", "raw"] as const;
export type OutputFormat = (typeof FORMATS)[number];
export interface FetchInput {
  url: string;
  format?: OutputFormat;
  maxChars?: number;
  timeoutMs?: number;
  removeImages?: boolean;
  includeReplies?: boolean | "extractors";
}
export type FetchPhase = "connecting" | "reading" | "extracting" | "downloading";
export interface ContentResult {
  kind: "content";
  url: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  title: string;
  author: string;
  published: string;
  site: string;
  language: string;
  wordCount: number;
  content: string;
  truncated: boolean;
  warnings: string[];
}
export interface FileResult {
  kind: "file";
  url: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  filePath: string;
  fileSize: number;
}
export type ErrorCode =
  | "invalid_request"
  | "disabled"
  | "cancelled"
  | "timeout"
  | "limit"
  | "network"
  | "http"
  | "extraction"
  | "download"
  | "unavailable";
export interface FailureResult {
  kind: "error";
  url: string;
  code: ErrorCode;
  message: string;
  statusCode?: number;
}
export type FetchResult = ContentResult | FileResult | FailureResult;
export interface BatchResult {
  kind: "batch";
  items: FetchResult[];
  total: number;
  succeeded: number;
  failed: number;
  cancelled: boolean;
  truncated: boolean;
}
export interface FetchProgress {
  phase: FetchPhase;
  completed?: number;
  total?: number;
}
export interface FetchHooks {
  signal?: AbortSignal;
  onProgress?: (progress: FetchProgress) => void;
}
