import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { FramedText } from "@eleith/pi-internal/frame";
import { buildSearchRendering } from "./render.ts";

type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

const theme = {
  fg: (_token: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;
const renderer = buildSearchRendering();
const options = { expanded: false, isPartial: false };
const rows = Array.from({ length: 9 }, (_, index) => `answer-${index + 1}`).join("\n");

function context(patch: Partial<ToolRenderContext> = {}): ToolRenderContext {
  return {
    args: {},
    toolCallId: "search-call",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/test",
    executionStarted: true,
    argsComplete: false,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 0,
    ...patch,
  };
}

function details(patch: Record<string, unknown> = {}) {
  return {
    version: 1,
    model: "gpt-search",
    status: "done",
    sources: [{ title: "Source", url: "https://example.org" }],
    searched: true,
    truncated: false,
    ...patch,
  };
}

function result(text = rows, overrides: { details?: unknown } = {}) {
  return { content: [{ type: "text" as const, text }], details: details(), ...overrides };
}

function plain(component: Component, width = 180) {
  return component
    .render(width)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join("\n");
}

it("defaults result details only when the override is omitted", () => {
  expect(result().details).toEqual(details());
  expect(result("", {}).details).toEqual(details());
  expect(result("", { details: undefined }).details).toBeUndefined();
});

it("uses the shared frame class and reuses components and stable redraws", () => {
  expect(renderer.renderShell).toBe("self");
  const call = renderer.renderCall({ query: "latest news" }, theme, context());
  expect(call).toBeInstanceOf(FramedText);
  expect(plain(call)).toContain("web_search_codex latest news");
  const painted = call.render(180);
  expect(call.render(180)).toBe(painted);
  expect(renderer.renderCall({ query: "updated" }, theme, context({ lastComponent: call }))).toBe(
    call,
  );
  expect(plain(call)).toContain("web_search_codex updated");

  const output = renderer.renderResult(result(), options, theme, context());
  expect(output).toBeInstanceOf(FramedText);
  const stable = output.render(180);
  expect(output.render(180)).toBe(stable);
  expect(plain(output)).toContain("answer-3");
  expect(plain(output)).not.toContain("answer-4");
  expect(plain(output)).toContain("done · 1 source · collapsed");
  expect(plain(output)).not.toContain("hidden");
  expect(
    renderer.renderResult(
      result(),
      { ...options, expanded: true },
      theme,
      context({ lastComponent: output }),
    ),
  ).toBe(output);
  expect(plain(output)).toContain("answer-9");
  expect(plain(output)).toContain("expanded");
  expect(plain(output)).not.toContain("hidden");
});

it("caps header queries at 50 visible columns even on wide screens", () => {
  const query = "模型🙂e\u0301".repeat(100);
  const header = renderer.renderCall({ query }, theme, context({ args: { query } }));
  for (const width of [80, 120, 250]) {
    const title = plain(header, width);
    const preview = title.split("web_search_codex ")[1].split(" ─")[0];
    expect(visibleWidth(preview)).toBeLessThanOrEqual(50);
    expect(preview).toMatch(/…$/);
    expect(title).not.toContain(query);
  }
  for (const width of [1, 5, 20, 40])
    for (const line of header.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  const collapsed = plain(header);
  renderer.renderCall(
    { query },
    theme,
    context({ args: { query }, expanded: true, lastComponent: header }),
  );
  expect(plain(header)).toBe(collapsed);
});

it.each(["searching", "answering", "done", "error"])(
  "always shows the full query in the %s main area",
  (status) => {
    const query = "模型🙂e\u0301".repeat(80);
    const state = {
      args: { query },
      isPartial: status === "searching" || status === "answering",
      isError: status === "error",
    };
    for (const expanded of [false, true]) {
      const output = renderer.renderResult(
        result("answer", { details: details({ status }) }),
        { expanded, isPartial: state.isPartial },
        theme,
        context({ ...state, expanded }),
      );
      for (const width of [40, 80, 120]) {
        const lines = plain(output, width).split("\n");
        expect(lines[0]).toBe("query");
        expect(lines.slice(1, lines.indexOf("")).join("")).toBe(query);
        expect(plain(output, width)).toContain("answer");
        for (const line of output.render(width))
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      for (const width of [1, 2, 5])
        for (const line of output.render(width))
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  },
);

it.each(["searching", "answering"])("bounds %s previews even when expanded", (status) => {
  const output = renderer.renderResult(
    result(rows, { details: details({ status }) }),
    { expanded: true, isPartial: true },
    theme,
    context({ isPartial: true }),
  );
  expect(plain(output)).toContain(status);
  expect(plain(output)).toContain("answer-3");
  expect(plain(output)).not.toContain("answer-4");
  renderer.renderResult(
    result(),
    { expanded: true, isPartial: false },
    theme,
    context({ lastComponent: output }),
  );
  expect(plain(output)).toContain("done");
  expect(plain(output)).toContain("answer-9");
});

it("wraps long final lines to preserve the full expanded answer", () => {
  const longLine = "abcdefghij".repeat(20);
  const output = renderer.renderResult(
    result(longLine),
    { expanded: true, isPartial: false },
    theme,
    context(),
  );
  const error = renderer.renderResult(
    result(longLine),
    { expanded: true, isPartial: false },
    theme,
    context({ isError: true }),
  );
  expect(
    error
      .render(40)
      .slice(0, -1)
      .map((line) => stripTerminalSequences(line).trimEnd())
      .join(""),
  ).toBe(longLine);
  const rendered = output.render(40);
  for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  expect(
    rendered
      .slice(0, -1)
      .map((line) => stripTerminalSequences(line).trimEnd())
      .join(""),
  ).toBe(longLine);
  const unicode = "模型🙂e\u0301".repeat(20);
  renderer.renderResult(
    result(unicode),
    { expanded: true, isPartial: false },
    theme,
    context({ lastComponent: output }),
  );
  expect(
    output
      .render(40)
      .slice(0, -1)
      .map((line) => stripTerminalSequences(line).trimEnd())
      .join(""),
  ).toBe(unicode);
});

it("handles empty streaming updates and either partial flag", () => {
  for (const [optionPartial, contextPartial] of [
    [true, false],
    [false, true],
  ]) {
    const output = renderer.renderResult(
      result("", { details: undefined }),
      { expanded: false, isPartial: optionPartial },
      theme,
      context({ isPartial: contextPartial }),
    );
    expect(plain(output)).toContain("searching");
    expect(output.render(80)).toHaveLength(1);
  }
});

it("summarizes no sources, plural sources, and provider truncation", () => {
  const empty = renderer.renderResult(
    result("", { details: details({ sources: [], searched: false }) }),
    options,
    theme,
    context(),
  );
  expect(plain(empty)).toContain("done · no sources");
  const multiple = renderer.renderResult(
    result("answer", {
      details: details({
        sources: [
          { title: "one", url: "https://one.example" },
          { title: "two", url: "https://two.example" },
        ],
        truncated: true,
      }),
    }),
    options,
    theme,
    context(),
  );
  expect(plain(multiple)).toContain("done · 2 sources · truncated");
});

it.each([
  undefined,
  null,
  "bad",
  [],
  {},
  details({ version: 2 }),
  details({ status: "unknown" }),
  details({ model: null }),
  details({ sources: null }),
  details({ sources: [{ title: 1, url: "https://example.org" }] }),
  details({ sources: [null] }),
  details({ searched: "yes" }),
  details({ truncated: "yes" }),
])("ignores absent, unknown, or malformed metadata: %j", (metadata) => {
  const output = renderer.renderResult(
    result("safe text", { details: metadata }),
    options,
    theme,
    context(),
  );
  const rendered = plain(output);
  expect(rendered).toContain("safe text");
  expect(rendered).toContain("done · collapsed");
  expect(rendered).not.toContain("source");
  expect(rendered).not.toContain("could not be rendered");
});

it.each([
  undefined,
  null,
  {},
  [],
  "unfinished JSON",
  { query: null },
  { query: 12 },
  { query: {} },
])("handles malformed or partial arguments: %j", (args) => {
  const output = renderer.renderCall(args, theme, context({ args }));
  expect(plain(output)).toContain("web_search_codex");
  expect(plain(output)).not.toContain("could not be rendered");
});

it("frames errors before partial state, with expansion and a fallback for empty errors", () => {
  const output = renderer.renderResult(
    result(rows),
    { expanded: false, isPartial: true },
    theme,
    context({ isPartial: true, isError: true }),
  );
  expect(plain(output)).toContain("✗ error");
  expect(plain(output)).toContain("answer-5");
  expect(plain(output)).not.toContain("answer-6");
  expect(plain(output)).not.toContain("hidden");
  renderer.renderResult(
    result(rows),
    { expanded: true, isPartial: false },
    theme,
    context({ isError: true, lastComponent: output }),
  );
  expect(plain(output)).toContain("answer-9");
  const empty = renderer.renderResult(result(""), options, theme, context({ isError: true }));
  expect(plain(empty)).toContain("Error");
  const metadataError = renderer.renderResult(
    result("failed", { details: details({ status: "error" }) }),
    options,
    theme,
    context(),
  );
  expect(plain(metadataError)).toContain("✗ error");
});

it("sanitizes query, output, and errors before styling, retaining only our ANSI", () => {
  const unsafe =
    "\x1b[31mred\x1b[0m\x1b]8;;https://evil.example\x07link\x1b]8;;\x07\x1b[2J\x1b]52;c;secret\x07\x1b_Gpayload\x1b\\\x07\x00";
  const call = renderer.renderCall({ query: `${unsafe}\r\nnext\tword` }, theme, context());
  const output = renderer.renderResult(
    result(`${unsafe}\r\nnext\rthird`),
    options,
    theme,
    context(),
  );
  const error = renderer.renderResult(result(unsafe), options, theme, context({ isError: true }));
  expect(plain(call)).toContain("redlink next word");
  expect(plain(output)).toContain("redlink\nnext\nthird");
  for (const component of [call, output, error]) {
    const raw = component.render(180).join("\n");
    expect(raw).toContain("\x1b[36m");
    expect(raw).not.toContain("\x1b[31m");
    expect(raw).not.toContain("\x1b[2J");
    expect(raw).not.toContain("\x1b]");
    expect(raw).not.toContain("\x1b_");
    expect(raw).not.toContain("\x07");
    expect(raw).not.toContain("\x00");
  }
});

it("extracts only valid text blocks, preserving line endings and ignoring images", () => {
  const output = renderer.renderResult(
    {
      content: [
        { type: "text", text: "one\r\ntwo" },
        { type: "image", data: "not text", mimeType: "image/png" },
        { type: "text", text: "three\rfour\n" },
      ],
      details: undefined,
    },
    { expanded: true, isPartial: false },
    theme,
    context(),
  );
  expect(plain(output)).toContain("one\ntwo\nthree\nfour");
  expect(plain(output)).not.toContain("not text");
  // Defensive handling of corrupted persisted text content.
  const malformed = renderer.renderResult(
    { content: [null, { type: "text", text: 42 }] as never, details: undefined },
    options,
    theme,
    context(),
  );
  expect(plain(malformed)).toContain("done");
});

it("fits unicode and ANSI at narrow/wide widths, resizes, and caps the frame at 210", () => {
  const unicode = "模型🙂e\u0301".repeat(100);
  const components = [
    renderer.renderCall({ query: unicode }, theme, context()),
    renderer.renderResult(result(`${unicode}\n${unicode}`), options, theme, context()),
    renderer.renderResult(result(unicode), options, theme, context({ isError: true })),
  ];
  for (const component of components) {
    for (const width of [1, 2, 5, 6, 10, 20, 80, 120, 250, 15, 80]) {
      for (const line of component.render(width))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(visibleWidth(stripTerminalSequences(component.render(width).at(-1)!).trimEnd())).toBe(
        Math.min(width, 210),
      );
    }
  }
});

it("rebuilds theme colors on invalidate and when callbacks receive a new theme", () => {
  let color = "\x1b[36m";
  const mutableTheme = {
    ...theme,
    fg: (_token: string, text: string) => `${color}${text}\x1b[39m`,
  } as Theme;
  const call = renderer.renderCall({ query: "query" }, mutableTheme, context());
  const output = renderer.renderResult(result("answer"), options, mutableTheme, context());
  for (const component of [call, output])
    expect(component.render(80).join("\n")).toContain("\x1b[36m");
  color = "\x1b[35m";
  for (const component of [call, output]) {
    component.invalidate();
    expect(component.render(80).join("\n")).toContain("\x1b[35m");
    expect(component.render(80).join("\n")).not.toContain("\x1b[36m");
  }
  expect(
    renderer.renderResult(result("new answer"), options, theme, context({ lastComponent: output })),
  ).toBe(output);
  expect(output.render(80).join("\n")).toContain("\x1b[36m");
  expect(output.render(80).join("\n")).not.toContain("\x1b[35m");
});
