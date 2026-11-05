import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** Sanitize untrusted display text before the renderer adds its own theme styling. */
export function sanitizeDisplayText(text: string): string {
  const withoutStrings = stripOscAndApcStrings(text);
  const plain = stripVTControlCharacters(withoutStrings);
  // Preserve tabs and line endings; remove binary controls and interlinear annotations.
  // oxlint-disable-next-line no-control-regex -- Match non-printing terminal controls explicitly.
  return plain.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFFF9-\uFFFB]/g, "");
}

// Pi 1.5's stripper can rescan unterminated strings quadratically. Consume each
// control string once, then let Node handle CSI/VT sequences without losing text.
function stripOscAndApcStrings(text: string): string {
  const parts: string[] = [];
  let copyFrom = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    const escapedString = char === "\x1b" && (next === "]" || next === "_");
    const c1String = char === "\x9d" || char === "\x9f";
    if (!escapedString && !c1String) continue;

    const visible = text.slice(copyFrom, index);
    parts.push(visible);
    index += escapedString ? 2 : 1;
    for (; index < text.length; index++) {
      const terminator = text[index];
      if (terminator === "\x07" || terminator === "\x9c") break;
      if (terminator === "\x1b" && text[index + 1] === "\\") {
        index++;
        break;
      }
    }
    // An unterminated string consumes the remainder instead of rescanning it.
    copyFrom = Math.min(index + 1, text.length);
  }
  const tail = text.slice(copyFrom);
  parts.push(tail);
  return parts.join("");
}

export function textFromResult(result: AgentToolResult<unknown>): string {
  const text = result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  return sanitizeDisplayText(text);
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
