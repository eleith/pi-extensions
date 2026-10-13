import { Type } from "@earendil-works/pi-ai";
import { LIMITS } from "./core/limits.ts";
import { FORMATS, type FetchInput } from "./core/types.ts";
import { checkFetchInput } from "./core/input.ts";

export const fetchSchema = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: LIMITS.maxUrlChars,
      description:
        "HTTP(S) source URL; public and private destinations are subject to host network restrictions. No URL credentials.",
    }),
    format: Type.Optional(
      Type.Union(
        FORMATS.map((format) => Type.Literal(format)),
        {
          default: "markdown",
          description:
            "markdown/html use extraction; json validates JSON responses and retains their source formatting. raw is the decoded HTTP body, not wire bytes, and skips extraction/alternate pages. No browser JavaScript execution.",
        },
      ),
    ),
    maxChars: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: LIMITS.maxChars,
        default: LIMITS.defaultMaxChars,
        description:
          "Content character limit beneath aggregate output/resource limits; truncation is reported.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: LIMITS.maxTimeoutMs,
        default: LIMITS.defaultTimeoutMs,
        description:
          "Whole-request deadline in milliseconds; cancellation is best-effort, not an immediate native networking stop.",
      }),
    ),
    removeImages: Type.Optional(Type.Boolean({ default: false })),
    includeReplies: Type.Optional(
      Type.Union([Type.Boolean(), Type.Literal("extractors")], {
        default: "extractors",
        description:
          "Include replies/comments: site extractors by default, true for all, false for none.",
      }),
    ),
  },
  { additionalProperties: false },
);
export const batchSchema = Type.Object(
  { requests: Type.Array(fetchSchema, { minItems: 1, maxItems: LIMITS.maxRequests }) },
  { additionalProperties: false },
);

const metadata = () => Type.String({ maxLength: LIMITS.maxMetadataChars });
const url = () => Type.String({ maxLength: LIMITS.maxUrlChars });
const statusCode = () => Type.Integer({ minimum: 100, maximum: 599 });
const source = { url: url(), finalUrl: url(), statusCode: statusCode(), contentType: metadata() };
export const fetchOutputSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("content"),
      ...source,
      title: metadata(),
      author: metadata(),
      published: metadata(),
      site: metadata(),
      language: metadata(),
      wordCount: Type.Integer({ minimum: 0 }),
      content: Type.String({ maxLength: LIMITS.maxChars }),
      truncated: Type.Boolean(),
      warnings: Type.Array(metadata(), { maxItems: 8 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("file"),
      ...source,
      filePath: Type.String({ maxLength: LIMITS.maxFilePathChars }),
      fileSize: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("error"),
      url: url(),
      code: Type.Union(
        [
          "invalid_request",
          "disabled",
          "cancelled",
          "timeout",
          "limit",
          "network",
          "http",
          "extraction",
          "download",
          "unavailable",
        ].map((code) => Type.Literal(code)),
      ),
      message: metadata(),
      statusCode: Type.Optional(statusCode()),
    },
    { additionalProperties: false },
  ),
]);
export const batchOutputSchema = Type.Object(
  {
    kind: Type.Literal("batch"),
    items: Type.Array(fetchOutputSchema, { maxItems: LIMITS.maxRequests }),
    total: Type.Integer({ minimum: 0, maximum: LIMITS.maxRequests }),
    succeeded: Type.Integer({ minimum: 0, maximum: LIMITS.maxRequests }),
    failed: Type.Integer({ minimum: 0, maximum: LIMITS.maxRequests }),
    cancelled: Type.Boolean(),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Recheck direct/programmatic calls before importing any execution/native modules. */
export function isFetchInput(value: unknown, checkDestination = true): value is FetchInput {
  return typeof checkFetchInput(value, checkDestination) !== "string";
}
export function isBatchInput(value: unknown): value is { requests: FetchInput[] } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.requests) &&
    value.requests.length >= 1 &&
    value.requests.length <= LIMITS.maxRequests &&
    // Schema/size errors reject the call; a type-correct but invalid destination
    // is an ordinary per-item core failure and must not erase valid siblings.
    value.requests.every((request) => isFetchInput(request, false))
  );
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
