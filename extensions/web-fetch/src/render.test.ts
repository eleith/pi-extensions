import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { FramedText } from "@eleith/pi-internal/frame";
import { expect, it } from "vitest";
import { buildFetchRendering } from "./render.ts";
import { presentResult } from "./tool.ts";
import type { ContentResult } from "./core/types.ts";

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
const theme = {
  fg: (_token: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;
const renderer = buildFetchRendering("web_fetch");
const options = { expanded: false, isPartial: false };
function context(patch: Partial<RenderContext> = {}): RenderContext {
  return {
    args: {},
    toolCallId: "fetch-call",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: "/workspace",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 0,
    ...patch,
  };
}
function outcome(patch: Partial<ContentResult> = {}): ContentResult {
  return {
    kind: "content",
    url: "https://example.test/requested",
    finalUrl: "https://example.test/final",
    statusCode: 200,
    contentType: "text/html",
    title: "Article title",
    author: "Jane",
    published: "2026-01-01",
    site: "Site",
    language: "en",
    wordCount: 100,
    content: Array.from({ length: 9 }, (_, index) => `article-${index + 1}`).join("\n"),
    truncated: false,
    warnings: [],
    ...patch,
  };
}
function plain(component: Component, width = 180): string {
  return component
    .render(width)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join("\n");
}
it("owns shared framed chrome, caches redraws and reuses call/result components", () => {
  const call = renderer.renderCall({ url: "https://example.test" }, theme, context());
  expect(call).toBeInstanceOf(FramedText);
  expect(plain(call)).toContain("web_fetch https://example.test");
  expect(call.render(80)).toBe(call.render(80));
  expect(
    renderer.renderCall({ url: "https://updated.test" }, theme, context({ lastComponent: call })),
  ).toBe(call);
  expect(plain(call)).toContain("updated.test");
  const result = presentResult(outcome());
  const output = renderer.renderResult(result, options, theme, context());
  expect(output).toBeInstanceOf(FramedText);
  expect(output.render(80)).toBe(output.render(80));
  expect(plain(output).split("\n")).toHaveLength(5);
  expect(plain(output)).toContain("article-2");
  expect(plain(output)).not.toContain("article-3");
  expect(plain(output)).toContain("Article title");
  expect(plain(output)).toContain("1 succeeded · 0 failed");
  expect(
    renderer.renderResult(
      result,
      { ...options, expanded: true },
      theme,
      context({ lastComponent: output }),
    ),
  ).toBe(output);
  expect(plain(output)).toContain("article-9");
  expect(plain(output)).toContain("Author: Jane\nPublished: 2026-01-01\nSite: Site\nLanguage: en");
});
it("shows actual phases/counts only, including empty updates and either partial flag", () => {
  for (const phase of ["connecting", "reading", "extracting", "downloading"]) {
    for (const [optionPartial, contextPartial] of [
      [true, false],
      [false, true],
    ]) {
      const output = renderer.renderResult(
        {
          content: [],
          details: {
            version: 1,
            status: phase,
            completed: 2,
            total: 4,
            succeeded: 0,
            failed: 0,
            truncated: false,
          },
        },
        { expanded: true, isPartial: optionPartial },
        theme,
        context({ isPartial: contextPartial }),
      );
      expect(plain(output)).toContain(`${phase} · 2/4`);
      expect(output.render(80)).toHaveLength(1);
    }
  }
});
it("shows truncation/warnings, file paths/bytes and actual errors in compact previews", () => {
  const clipped = renderer.renderResult(
    presentResult(outcome({ truncated: true, warnings: ["alternate unavailable"] })),
    options,
    theme,
    context(),
  );
  expect(plain(clipped)).toContain("truncated · 1 warnings");
  const file = renderer.renderResult(
    presentResult({
      kind: "file",
      url: "https://example.test",
      finalUrl: "https://example.test/file",
      statusCode: 200,
      contentType: "application/pdf",
      fileSize: 4567,
      filePath: "/workspace/private/file.pdf",
    }),
    options,
    theme,
    context(),
  );
  expect(plain(file)).toContain("HTTP 200 · file · 4567 bytes\nFile: /workspace/private/file.pdf");
  const error = renderer.renderResult(
    presentResult({
      kind: "error",
      url: "https://example.test",
      code: "timeout",
      message: "timeout",
    }),
    { expanded: false, isPartial: true },
    theme,
    context({ isPartial: true }),
  );
  expect(plain(error)).toContain("Error (timeout): Fetch deadline exceeded.");
  expect(plain(error)).toContain("✗ error");
});
it("keeps mixed batch failures visible ahead of success previews and preserves all expanded metadata", () => {
  const result = presentResult({
    kind: "batch",
    total: 2,
    succeeded: 1,
    failed: 1,
    cancelled: false,
    truncated: false,
    items: [
      outcome(),
      {
        kind: "error",
        code: "http",
        statusCode: 404,
        url: "https://missing.test",
        message: "missing",
      },
    ],
  });
  const batchRenderer = buildFetchRendering("web_fetch_batch");
  expect(
    plain(
      batchRenderer.renderCall(
        { requests: Array.from({ length: 2 }, () => ({ url: "https://example.test" })) },
        theme,
        context(),
      ),
    ),
  ).toContain("web_fetch_batch 2 requests");
  const output = batchRenderer.renderResult(result, options, theme, context());
  expect(plain(output)).toContain("Error (http)");
  expect(plain(output)).toContain("1 succeeded · 1 failed");
  expect(plain(output)).not.toContain("✗ error");
  batchRenderer.renderResult(
    result,
    { expanded: true, isPartial: false },
    theme,
    context({ lastComponent: output }),
  );
  expect(plain(output)).toContain("article-9");
  expect(plain(output)).toContain("Error (http) · HTTP 404");
});
it("wraps full expanded content and metadata rather than clipping fetched long lines", () => {
  const unicode = "模型🙂e\u0301".repeat(100);
  const result = presentResult(outcome({ content: unicode }));
  const output = renderer.renderResult(
    result,
    { expanded: true, isPartial: false },
    theme,
    context(),
  );
  const text = result.content[0];
  if (text.type !== "text") throw Error("Expected text");
  for (const width of [40, 80]) {
    const rendered = output
      .render(width)
      .slice(0, -1)
      .map((line) => stripTerminalSequences(line).trimEnd());
    expect(rendered.join("")).toBe(text.text.replace(/\n/g, ""));
  }
});
it.each([
  undefined,
  null,
  [],
  {},
  "bad",
  { version: 2 },
  { version: 1, status: "unknown" },
  { version: 1, status: "done", truncated: "yes" },
  {
    results: [],
    normalizedRequests: [{ headers: { Authorization: "secret" }, proxy: "credential" }],
  },
])("safely falls back for malformed/old details %j", (details) => {
  const output = renderer.renderResult(
    { content: [{ type: "text", text: "old article content" }], details },
    options,
    theme,
    context(),
  );
  expect(plain(output)).toContain("old article content");
  expect(plain(output)).not.toContain("secret");
  expect(plain(output)).not.toContain("credential");
  expect(plain(output)).not.toContain("could not be rendered");
});
it("bounds hostile history and malformed args without copying legacy headers/proxies", () => {
  const details = {
    version: 1,
    status: "done",
    truncated: false,
    total: Infinity,
    failed: -2,
    succeeded: "bad",
    requests: [{ url: "bad", headers: { Authorization: "secret" }, proxy: "credential" }],
  };
  const output = renderer.renderResult(
    { content: [{ type: "text", text: "x".repeat(300_000) }], details: { old: details } },
    { expanded: true, isPartial: false },
    theme,
    context(),
  );
  expect(plain(output).length).toBeLessThan(18_000);
  expect(plain(output)).toContain("[History preview bounded]");
  for (const args of [
    null,
    [],
    "bad",
    { url: 12 },
    { headers: { Authorization: "secret" }, proxy: "credential" },
    { url: "模型🙂".repeat(10_000) },
  ]) {
    const call = renderer.renderCall(args, theme, context({ args }));
    expect(plain(call).length).toBeLessThan(300);
    expect(plain(call)).not.toContain("secret");
    expect(plain(call)).not.toContain("credential");
  }
});
it("strips terminal sequences/raw controls from all untrusted fields before applying theme", () => {
  const unsafe =
    "\x1b[31mred\x1b[0m\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\x1b[2J\x1b]52;c;secret\x07\x1b_Gpayload\x1b\\\x00\x07\u009b";
  const result = presentResult(
    outcome({ url: unsafe, finalUrl: unsafe, title: unsafe, content: `${unsafe}\r\nnext\tword` }),
  );
  const components = [
    renderer.renderCall({ url: unsafe }, theme, context()),
    renderer.renderResult(result, options, theme, context()),
    renderer.renderResult(
      result,
      { expanded: true, isPartial: false },
      theme,
      context({ isError: true }),
    ),
  ];
  for (const component of components) {
    const raw = component.render(180).join("\n");
    expect(raw).toContain("\x1b[36m");
    for (const injection of [
      "\x1b[31m",
      "\x1b[2J",
      "\x1b]",
      "\x1b_",
      "\x00",
      "\x07",
      "\u009b",
      "\r",
      "\t",
    ])
      expect(raw).not.toContain(injection);
    expect(plain(component)).toContain("redlink");
  }
});
it("fits widths 1/5/40/80 and Unicode, resizes and refreshes theme on invalidation", () => {
  let color = "\x1b[36m";
  const changingTheme = {
    ...theme,
    fg: (_token: string, text: string) => `${color}${text}\x1b[39m`,
  } as Theme;
  const unicode = "模型🙂e\u0301".repeat(100);
  const components = [
    renderer.renderCall({ url: unicode }, changingTheme, context()),
    renderer.renderResult(
      presentResult(outcome({ content: unicode })),
      options,
      changingTheme,
      context(),
    ),
    renderer.renderResult(
      presentResult(outcome({ content: unicode })),
      { expanded: true, isPartial: false },
      changingTheme,
      context({ isError: true }),
    ),
  ];
  for (const component of components) {
    for (const width of [1, 5, 40, 80, 250, 5, 80]) {
      for (const line of component.render(width))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  }
  color = "\x1b[35m";
  for (const component of components) {
    component.invalidate();
    expect(component.render(80).join("\n")).toContain(color);
    expect(component.render(80).join("\n")).not.toContain("\x1b[36m");
  }
});
