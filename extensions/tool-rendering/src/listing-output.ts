import {
  DEFAULT_MAX_BYTES,
  formatSize,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

/**
 * Separate exact metadata-backed native suffixes, leaving other bracketed text alone.
 * Call before sanitation so malformed filename controls cannot swallow Pi's notice.
 */
export function splitListingNotice(
  text: string,
  tool: "ls" | "find",
  limitReached: number | undefined,
  truncation: TruncationResult | undefined,
): { text: string; notice: string } {
  let limitNotices = [""];
  if (limitReached !== undefined) {
    const unit = tool === "ls" ? "entries" : "results";
    const limitNotice = `${limitReached} ${unit} limit reached`;
    const nextLimit = limitReached * 2;
    let suggestion = `Use limit=${nextLimit} for more`;
    if (tool === "find") suggestion += ", or refine pattern";
    limitNotices = [`${limitNotice}. ${suggestion}`];
    // Custom FindOperations omit the follow-up suggestion that fd includes.
    if (tool === "find") limitNotices.push(limitNotice);
  }

  let byteNotice = "";
  if (truncation?.truncated) {
    const maxBytes = truncation.maxBytes ?? DEFAULT_MAX_BYTES;
    const size = formatSize(maxBytes);
    byteNotice = `${size} limit reached`;
  }

  for (const limitNotice of limitNotices) {
    const notices = [limitNotice, byteNotice].filter(Boolean);
    if (notices.length === 0) continue;
    const message = notices.join(". ");
    const notice = `[${message}]`;
    const suffix = `\n\n${notice}`;
    if (text.endsWith(suffix)) {
      const body = text.slice(0, -suffix.length);
      return { text: body, notice };
    }
  }
  return { text, notice: "" };
}
