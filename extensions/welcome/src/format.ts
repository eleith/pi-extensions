/** Saved entries and live metadata are sanitized at the display boundary. */
export function safe(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
    : "";
}

export function summarize(names: string[], prefix = ""): string {
  const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  if (!unique.length) return "0 found";
  const shown = unique.slice(0, 3).map((name) => prefix + safe(name));
  return shown.join(", ") + (unique.length > 3 ? ` +${unique.length - 3}` : "");
}
