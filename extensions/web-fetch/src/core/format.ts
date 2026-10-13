import { LIMITS } from "./limits.ts";
import type { OutputFormat } from "./types.ts";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function estimateWordCount(content: string): number {
  return content.trim().match(/\S+/g)?.length ?? 0;
}

export function renderJsonContent(body: string, format: OutputFormat): string {
  if (format === "html") return `<pre><code class="language-json">${escapeHtml(body)}</code></pre>`;
  if (format === "markdown") return `\`\`\`json\n${body}\n\`\`\``;
  return body;
}

export function boundedMetadata(value: unknown): string {
  return typeof value === "string"
    ? value.slice(0, LIMITS.maxMetadataChars).replace(/\p{Cc}/gu, " ")
    : "";
}

export function limitContent(
  content: string,
  requested: number | undefined,
  format: OutputFormat,
): {
  content: string;
  truncated: boolean;
  warnings: string[];
} {
  const maxChars = Number.isFinite(requested)
    ? Math.max(0, Math.min(Math.floor(requested!), LIMITS.maxChars))
    : LIMITS.defaultMaxChars;
  if (content.length <= maxChars) return { content, truncated: false, warnings: [] };
  // Do not append prose to JSON/HTML/raw data and pretend the result is valid serialization.
  const notice = "\n\n[Content truncated]";
  const readable = format === "markdown";
  const suffix = readable && maxChars >= notice.length ? notice : "";
  let prefix = content.slice(0, maxChars - suffix.length);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return {
    content: prefix + suffix,
    truncated: true,
    warnings: [
      readable
        ? "Content truncated to maxChars."
        : "Content truncated to maxChars; this is a partial body, not necessarily valid serialized data.",
    ],
  };
}
