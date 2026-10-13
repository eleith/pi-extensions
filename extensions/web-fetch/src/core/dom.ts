/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { OutputFormat } from "./types.ts";

/** Defuddle needs these two Linkedom shims. Keep them on this document, not globalThis. */
export async function parseLinkedomHTML(html: string, url: string): Promise<Document> {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(html);
  const doc = document as unknown as Document;
  Object.defineProperty(doc, "styleSheets", { value: [], configurable: true });
  // Linkedom's window is a proxy over globalThis: assigning to it pollutes Node globals.
  const view = Object.create(doc.defaultView) as Window;
  Object.defineProperty(view, "getComputedStyle", {
    value: () => ({ display: "", visibility: "" }),
  });
  Object.defineProperty(doc, "defaultView", { value: view, configurable: true });
  Object.defineProperty(doc, "URL", { value: url, configurable: true });
  return doc;
}

function httpTarget(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    // Invalid hints are not requests. The request owner validates accepted hints again.
  }
  return undefined;
}

export function documentBase(document: Document, finalUrl: string): string {
  return (
    httpTarget(document.head?.querySelector("base[href]")?.getAttribute("href") ?? "", finalUrl) ??
    finalUrl
  );
}

export async function inspectHtml(
  body: string,
  finalUrl: string,
  format: OutputFormat,
): Promise<{ redirect?: string; alternates: string[] }> {
  if (format === "raw") return { alternates: [] };
  const document = await parseLinkedomHTML(body, finalUrl);
  const base = documentBase(document, finalUrl);
  let redirect: string | undefined;
  for (const meta of document.head?.querySelectorAll("meta[http-equiv]") ?? []) {
    if (meta.getAttribute("http-equiv")?.trim().toLowerCase() !== "refresh") continue;
    const match = meta
      .getAttribute("content")
      ?.match(/^\s*(\d+(?:\.\d+)?|\.\d+)\s*;\s*url\s*=\s*(.*?)\s*$/i);
    if (!match || Number(match[1]) >= 30) continue;
    const target = match[2].replace(/^(['"])([\s\S]*)\1$/, "$2");
    if (!target) continue;
    const resolved = httpTarget(target, base);
    if (resolved && resolved !== finalUrl) {
      redirect = resolved;
      break;
    }
  }
  const accepted: Record<OutputFormat, string[]> = {
    markdown: ["text/markdown", "text/x-markdown"],
    html: ["text/html", "application/xhtml+xml"],
    json: ["application/json", "text/json"],
    raw: [],
  };
  const alternates: string[] = [];
  for (const link of document.head?.querySelectorAll("link[rel][href][type]") ?? []) {
    if (!(link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("alternate"))
      continue;
    const type = (link.getAttribute("type") ?? "").split(";")[0].trim().toLowerCase();
    if (
      !accepted[format].includes(type) &&
      !(format === "json" && /^[\w.+-]+\/[\w.+-]+\+json$/.test(type))
    )
      continue;
    const target = httpTarget(link.getAttribute("href") ?? "", base);
    if (!target || target === finalUrl || alternates.includes(target)) continue;
    alternates.push(target);
    if (alternates.length === 3) break;
  }
  return { ...(redirect ? { redirect } : {}), alternates };
}
