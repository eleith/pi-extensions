import { LIMITS } from "./limits.ts";
import { FORMATS, type FetchInput } from "./types.ts";

const FIELDS = new Set([
  "url",
  "format",
  "maxChars",
  "timeoutMs",
  "removeImages",
  "includeReplies",
]);

/** Host-free validation/defaults shared by startup guards and execution.
 * Batch shape checks defer destination semantics so invalid URLs fail per item.
 */
export function checkFetchInput(
  value: unknown,
  checkDestination = true,
): Required<FetchInput> | string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Expected a fetch request object.";
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !FIELDS.has(key)))
    return "Unsupported fetch argument. Custom headers and transport overrides belong in bash/curl/wget.";
  if (typeof input.url !== "string" || !input.url || input.url.length > LIMITS.maxUrlChars)
    return "Provide an HTTP(S) URL within the URL length limit.";
  let url = input.url;
  if (checkDestination) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "Invalid URL.";
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      return "Only HTTP(S) URLs without embedded credentials are supported.";
    if (parsed.href.length > LIMITS.maxUrlChars) return "Encoded URL exceeds the URL length limit.";
    url = parsed.href;
  }
  const format = input.format === undefined ? "markdown" : input.format;
  if (typeof format !== "string" || !FORMATS.some((candidate) => candidate === format))
    return "Unsupported output format.";
  const maxChars = input.maxChars === undefined ? LIMITS.defaultMaxChars : input.maxChars;
  const timeoutMs = input.timeoutMs === undefined ? LIMITS.defaultTimeoutMs : input.timeoutMs;
  if (
    typeof maxChars !== "number" ||
    !Number.isInteger(maxChars) ||
    maxChars < 1 ||
    maxChars > LIMITS.maxChars
  )
    return `maxChars must be an integer from 1 to ${LIMITS.maxChars}.`;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > LIMITS.maxTimeoutMs
  )
    return `timeoutMs must be an integer from 1 to ${LIMITS.maxTimeoutMs}.`;
  if (input.removeImages !== undefined && typeof input.removeImages !== "boolean")
    return "removeImages must be boolean.";
  if (
    input.includeReplies !== undefined &&
    typeof input.includeReplies !== "boolean" &&
    input.includeReplies !== "extractors"
  )
    return "includeReplies must be boolean or extractors.";
  return {
    url,
    format: format as Required<FetchInput>["format"],
    maxChars,
    timeoutMs,
    removeImages: (input.removeImages as boolean | undefined) ?? false,
    includeReplies: (input.includeReplies as boolean | "extractors" | undefined) ?? "extractors",
  };
}
