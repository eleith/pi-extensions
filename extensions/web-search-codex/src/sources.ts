export interface SearchSource {
  title: string;
  url: string;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Keep only useful public metadata; never retain raw provider events. */
export class SearchSources {
  private readonly byUrl = new Map<string, SearchSource>();
  private readonly cited = new Set<string>();
  searched = false;
  completed = false;
  truncated = false;

  snapshot(): SearchSource[] {
    return Array.from(this.byUrl.values(), (source) => ({ ...source }));
  }

  observe(data: unknown): void {
    const event = asRecord(data);
    if (!event) return;
    if (
      event.type === "response.web_search_call.in_progress" ||
      event.type === "response.web_search_call.searching" ||
      event.type === "response.web_search_call.completed"
    ) {
      this.searched = true;
      if (event.type === "response.web_search_call.completed") this.completed = true;
    }
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      this.observeItem(event.item);
    }
    if (event.type === "response.output_text.annotation.added")
      this.observeCitation(event.annotation);
    if (
      event.type === "response.completed" ||
      event.type === "response.done" ||
      event.type === "response.incomplete"
    ) {
      const response = asRecord(event.response);
      if (Array.isArray(response?.output)) {
        for (const item of response.output) this.observeItem(item);
      }
    }
  }

  private observeItem(value: unknown): void {
    const item = asRecord(value);
    if (!item) return;
    if (item.type === "web_search_call") {
      this.searched = true;
      if (item.status === "completed") this.completed = true;
      const action = asRecord(item.action);
      if (Array.isArray(action?.sources)) {
        for (const source of action.sources) this.addSource(source);
      }
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const value of item.content) {
        const content = asRecord(value);
        if (content?.type === "output_text" && Array.isArray(content.annotations)) {
          for (const annotation of content.annotations) this.observeCitation(annotation);
        }
      }
    }
  }

  private observeCitation(value: unknown): void {
    const annotation = asRecord(value);
    if (annotation?.type !== "url_citation") return;
    this.addSource(asRecord(annotation.url_citation) ?? annotation, true);
  }

  private addSource(value: unknown, citation = false): void {
    const source = asRecord(value);
    if (typeof source?.url !== "string" || source.url.length > 2048) return;
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      return;
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return;
    const key = url.href;
    const title =
      typeof source.title === "string" && source.title.trim()
        ? source.title.trim().slice(0, 300)
        : url.hostname;
    const existing = this.byUrl.get(key);
    if (existing) {
      if (citation) this.cited.add(key);
      if (existing.title === url.hostname) existing.title = title;
      return;
    }
    if (this.byUrl.size >= 50) {
      this.truncated = true;
      const uncited = citation
        ? Array.from(this.byUrl.keys()).find((url) => !this.cited.has(url))
        : undefined;
      if (!uncited) return;
      this.byUrl.delete(uncited);
    }
    this.byUrl.set(key, { title, url: key });
    if (citation) this.cited.add(key);
  }
}
