import { expect, it } from "vitest";
import { SearchSources } from "./sources.ts";

it("collects streamed and terminal search sources and citations without duplicates", () => {
  const sources = new SearchSources();
  sources.observe({
    type: "response.output_item.added",
    item: {
      type: "web_search_call",
      status: "in_progress",
      action: { sources: [{ url: "https://example.com" }] },
    },
  });
  sources.observe({
    type: "response.output_text.annotation.added",
    annotation: { type: "url_citation", url: "https://example.com/", title: "Example" },
  });
  sources.observe({
    type: "response.done",
    response: {
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: { sources: [{ url: "https://second.example/", title: "Second" }] },
        },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: { url: "https://example.com/", title: "Example" },
                },
              ],
            },
          ],
        },
      ],
    },
  });
  expect(sources.searched).toBe(true);
  expect(sources.completed).toBe(true);
  expect(sources.snapshot()).toEqual([
    { title: "Example", url: "https://example.com/" },
    { title: "Second", url: "https://second.example/" },
  ]);
  const snapshot = sources.snapshot();
  snapshot[0].title = "changed";
  expect(sources.snapshot()[0].title).toBe("Example");
});

it("tolerates unknown events and unsafe or malformed URLs", () => {
  const sources = new SearchSources();
  for (const event of [
    null,
    [],
    "wrong",
    {
      type: "response.completed",
      response: { output: [null, {}, { type: "message", content: [null] }] },
    },
  ])
    sources.observe(event);
  for (const url of [
    "not a URL",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:password@example.com",
    4,
  ]) {
    sources.observe({
      type: "response.output_text.annotation.added",
      annotation: { type: "url_citation", url },
    });
  }
  expect(sources.snapshot()).toEqual([]);
  expect(sources.searched).toBe(false);
  sources.observe({ type: "response.web_search_call.searching" });
  expect(sources.searched).toBe(true);
});

it("bounds source metadata and never retains raw data", () => {
  const sources = new SearchSources();
  sources.observe({
    type: "response.output_item.done",
    item: {
      type: "web_search_call",
      action: {
        sources: Array.from({ length: 60 }, (_, index) => ({
          url: `https://example.com/${index}`,
          title: "x".repeat(1000),
          raw: "secret",
        })),
      },
    },
  });
  expect(sources.snapshot()).toHaveLength(50);
  expect(sources.truncated).toBe(true);
  expect(sources.snapshot()[0].title).toHaveLength(300);
  expect(JSON.stringify(sources.snapshot())).not.toContain("secret");
});

it("distinguishes searching or failed calls from completed native searches", () => {
  const sources = new SearchSources();
  sources.observe({ type: "response.web_search_call.searching" });
  expect(sources.completed).toBe(false);
  sources.observe({
    type: "response.output_item.done",
    item: { type: "web_search_call", status: "failed" },
  });
  expect(sources.completed).toBe(false);
  sources.observe({ type: "response.web_search_call.completed" });
  expect(sources.completed).toBe(true);
});

it("keeps citations even when consulted pages fill the metadata cap", () => {
  const sources = new SearchSources();
  sources.observe({
    type: "response.output_item.done",
    item: {
      type: "web_search_call",
      status: "completed",
      action: {
        sources: Array.from({ length: 50 }, (_, index) => ({
          url: `https://example.com/${index}`,
        })),
      },
    },
  });
  sources.observe({
    type: "response.output_text.annotation.added",
    annotation: {
      type: "url_citation",
      title: "The actual citation",
      url: "https://cited.example/",
    },
  });
  expect(sources.snapshot()).toHaveLength(50);
  expect(sources.snapshot()).toContainEqual({
    title: "The actual citation",
    url: "https://cited.example/",
  });
  expect(sources.truncated).toBe(true);
  for (let index = 0; index < 60; index++)
    sources.observe({
      type: "response.output_text.annotation.added",
      annotation: { type: "url_citation", url: `https://citations.example/${index}` },
    });
  expect(sources.snapshot()).toHaveLength(50);
  expect(sources.snapshot()).toContainEqual({
    title: "The actual citation",
    url: "https://cited.example/",
  });
});
