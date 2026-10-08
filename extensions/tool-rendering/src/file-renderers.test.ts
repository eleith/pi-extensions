import { rmSync } from "node:fs";
import { truncateHead, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { afterAll, expect, it, vi } from "vitest";
import { buildReadRendering } from "./read.ts";
import { buildWriteRendering } from "./write.ts";
import { buildEditRendering } from "./edit.ts";
import { buildGrepRendering } from "./grep.ts";
import { buildFindRendering } from "./find.ts";
import { buildLsRendering } from "./ls.ts";
import { FramedText } from "./frame.ts";

// The root SDK loads provider/config modules: isolate it before any imports run.
const directory = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "file-renderers-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

const builders = {
  read: buildReadRendering,
  write: buildWriteRendering,
  edit: buildEditRendering,
  grep: buildGrepRendering,
  find: buildFindRendering,
  ls: buildLsRendering,
};
type Name = keyof typeof builders;
type Tools = { [K in Name]: ReturnType<(typeof builders)[K]> };
type ReadContext = Parameters<NonNullable<Tools["read"]["renderCall"]>>[2];
const names = Object.keys(builders) as Name[];
const minimalTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const theme = minimalTheme as unknown as Theme;
const options = { expanded: false, isPartial: false };
const longText = "界🙂é".repeat(55);
const rows = Array.from({ length: 14 }, (_, i) => `row-${i + 1}`).join("\n");
const presets = {
  read: {
    args: { path: "file.txt", offset: 995, limit: 14 },
    result: { content: [{ type: "text", text: rows }], details: undefined },
    title: "read file.txt from 995 (14 lines)",
  },
  write: {
    args: { path: "file.txt", content: rows },
    result: { content: [{ type: "text", text: "written" }], details: undefined },
    title: "write file.txt",
  },
  edit: {
    args: { path: "file.txt", edits: [{ oldText: "old", newText: "new" }] },
    result: {
      content: [{ type: "text", text: "edited" }],
      details: {
        diff:
          "*** Begin Patch\n@@ chunk\n-old\n" +
          Array.from({ length: 9 }, (_, i) => `+new-${i}`).join("\n"),
        patch: "",
      },
    },
    title: "edit file.txt (1 edits)",
  },
  grep: {
    args: { pattern: "hit", path: "src", glob: "*.ts" },
    result: {
      content: [
        {
          type: "text",
          text: "a.ts:1:hit\na.ts-2-context\n--\nb.ts:3:hit\nc.ts:4:hit\nd.ts:5:hit",
        },
      ],
      details: undefined,
    },
    title: "grep hit in src (*.ts)",
  },
  find: {
    args: { pattern: "*.ts", path: "src", limit: 4 },
    result: {
      content: [{ type: "text", text: "a/one.ts\nb/two.ts\nc/three.ts\nd/four.ts" }],
      details: undefined,
    },
    title: "find *.ts in src (4 files)",
  },
  ls: {
    args: { path: "src", limit: 14 },
    result: { content: [{ type: "text", text: rows }], details: undefined },
    title: "ls src (14 entries)",
  },
} satisfies {
  [K in Name]: {
    args: Parameters<NonNullable<Tools[K]["renderCall"]>>[0];
    result: Parameters<NonNullable<Tools[K]["renderResult"]>>[0];
    title: string;
  };
};

function context<A>(args: A, patch: Partial<Omit<ReadContext, "args">> = {}) {
  return {
    args,
    toolCallId: "call",
    invalidate: () => {},
    lastComponent: undefined as Component | undefined,
    state: {},
    cwd: directory,
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
function capture<K extends Name>(name: K) {
  return { tool: builders[name]() as Tools[K] };
}
function text(component: Component, width = 180) {
  return component
    .render(width)
    .map((line) => line.trimEnd())
    .join("\n");
}
// Only the table-driven tests erase the differing builtin parameter schemas.
function erased(tool: Tools[Name]): ToolRenderers {
  return tool as ToolRenderers;
}

it.each(names)("builds only %s presentation and preserves its title fields", (name) => {
  const { tool } = capture(name);
  expect(Object.keys(tool)).toEqual(["renderShell", "renderCall", "renderResult"]);
  expect(tool.renderShell).toBe("self");
  const renderer = erased(tool);
  const call = renderer.renderCall!(presets[name].args, theme, context(presets[name].args));
  expect(text(call)).toContain(presets[name].title);
});

it.each(names)("repaints %s call and result at actual widths after resize", (name) => {
  const { tool: captured } = capture(name);
  const tool = erased(captured);
  const args = { ...presets[name].args, path: longText, pattern: longText, content: longText };
  const ctx = context(args);
  const call = tool.renderCall!(args, theme, ctx);
  const result = tool.renderResult!(
    {
      content: [{ type: "text", text: name === "grep" ? `file:1:${longText}` : longText }],
      details: undefined,
    },
    options,
    theme,
    ctx,
  );
  for (const component of [call, result]) {
    expect(component).toBeInstanceOf(FramedText);
    for (const width of [50, 12, 3, 90, 50]) {
      const lines = component.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(visibleWidth(component === call ? lines[0] : lines.at(-1)!)).toBe(width);
    }
    expect(text(component, 90)).not.toBe(text(component, 50));
  }
  expect(tool.renderCall!(args, theme, { ...ctx, lastComponent: call })).toBe(call);
  expect(
    tool.renderResult!(presets[name].result, options, theme, { ...ctx, lastComponent: result }),
  ).toBe(result);
});

it.each(names)("keeps bounded collapsed %s previews and full expanded content", (name) => {
  const { tool: captured } = capture(name);
  const tool = erased(captured);
  const preset = presets[name];
  const component = tool.renderResult!(preset.result, options, theme, context(preset.args));
  const output = text(component);
  const expected = {
    read: [10, 4],
    write: [10, 4],
    edit: [8, 3],
    grep: [8, 3],
    find: [8, 1],
    ls: [10, 4],
  }[name];
  expect(component.render(180).length - 1).toBeLessThanOrEqual(expected[0]);
  expect(output).toContain(`collapsed · ${expected[1]} hidden`);
  const expanded = tool.renderResult!(
    preset.result,
    { ...options, expanded: true },
    theme,
    context(preset.args, { lastComponent: component, expanded: true }),
  );
  expect(expanded).toBe(component);
  expect(text(expanded)).toContain("expanded");
  expect(text(expanded)).not.toContain("hidden");
  expect(text(expanded)).toContain(
    {
      read: "row-14",
      write: "row-14",
      edit: "+new-8",
      grep: "d.ts",
      find: "four.ts",
      ls: "row-14",
    }[name],
  );
});

it("numbers read offsets using the maximum displayed number and preserves image/truncation labels", () => {
  const { tool } = capture("read");
  const ctx = context(presets.read.args);
  const truncated = {
    ...presets.read.result,
    details: { truncation: truncateHead(rows, { maxLines: 12 }) },
  };
  const output = text(tool.renderResult!(truncated, options, theme, ctx));
  expect(output).toContain(" 995 │ row-1");
  expect(output).toContain("1004 │ row-10");
  expect(output).not.toContain("row-11");
  expect(output).toContain("14 lines · truncated");
  expect(
    text(
      tool.renderResult!(
        { content: [{ type: "image", data: "", mimeType: "image/png" }], details: undefined },
        options,
        theme,
        ctx,
      ),
    ),
  ).toContain("image · collapsed");
  expect(
    text(tool.renderResult!({ content: [], details: undefined }, options, theme, ctx)),
  ).toContain("0 lines");
});

it("retains edit diff stats and colors, excluding patch framing from the preview", () => {
  const { tool } = capture("edit");
  const fg = vi.fn((_color: string, value: string) => value);
  const output = text(
    tool.renderResult!(
      presets.edit.result,
      options,
      { ...minimalTheme, fg } as unknown as Theme,
      context(presets.edit.args),
    ),
  );
  expect(output).toContain("+9 -1");
  expect(output).not.toContain("*** Begin Patch");
  expect(fg).toHaveBeenCalledWith("toolDiffRemoved", "-old");
  expect(fg).toHaveBeenCalledWith("toolDiffAdded", "+new-0");
});

it.each([
  ["h.t", false, false, ["hit", "hat", "h.t"]],
  ["h.t", true, false, ["h.t"]],
  ["HIT", false, true, ["hit", "HIT"]],
  ["HIT", false, false, ["HIT"]],
  ["[", false, false, []],
] as const)(
  "groups grep results and highlights %s (literal %s, ignoreCase %s)",
  (pattern, literal, ignoreCase, highlights) => {
    const { tool } = capture("grep");
    const fg = vi.fn((_color: string, value: string) => value);
    const args = { pattern, literal, ignoreCase };
    const result = {
      content: [
        { type: "text" as const, text: "a.ts:1:hit hat h.t HIT\na.ts-2-context\n--\nb.ts:3:other" },
      ],
      details: { matchLimitReached: 2, linesTruncated: true },
    };
    const output = text(
      tool.renderResult!(
        result,
        { ...options, expanded: true },
        { ...minimalTheme, fg } as unknown as Theme,
        context(args),
      ),
    );
    expect(output).toContain("a.ts\n    1 │ hit hat h.t HIT\n    2 │ context\n  ···\n\nb.ts");
    expect(output).toContain("2 matches · limit reached · truncated");
    expect(
      fg.mock.calls.filter(([color]) => color === "warning").map(([, value]) => value),
    ).toEqual(highlights);
  },
);

it.each(names)("colors partial/error %s frames and limits error previews to five lines", (name) => {
  const { tool: captured } = capture(name);
  const tool = erased(captured);
  const fg = vi.fn((_color: string, value: string) => value);
  const coloredTheme = { ...minimalTheme, fg } as unknown as Theme;
  const preset = presets[name];
  const ctx = context(preset.args, { isPartial: true });
  text(tool.renderCall!(preset.args, coloredTheme, ctx));
  text(tool.renderResult!(preset.result, { ...options, isPartial: true }, coloredTheme, ctx));
  expect(fg).toHaveBeenCalledWith("warning", expect.stringContaining("─"));
  const error = tool.renderResult!(
    { content: [{ type: "text", text: rows }], details: undefined },
    options,
    coloredTheme,
    { ...ctx, isError: true },
  );
  expect(text(error)).toContain("✗ error · collapsed · 9 hidden");
  expect(error.render(180)).toHaveLength(6);
  expect(fg).toHaveBeenCalledWith("error", expect.stringContaining("─"));
  expect(
    text(
      tool.renderResult!(
        { content: [{ type: "text", text: rows }], details: undefined },
        { ...options, expanded: true },
        theme,
        { ...ctx, isError: true },
      ),
    ),
  ).toContain("row-14");
});

it.each(["ls", "find"] as const)("keeps legacy %s details.rendering.text readable", (name) => {
  const { tool: captured } = capture(name);
  const tool = erased(captured);
  const result = {
    content: [{ type: "text" as const, text: "model-facing text" }],
    details: {
      rendering: { text: "src/old.ts\nsrc/next.ts" },
      entryLimitReached: 2,
      resultLimitReached: 2,
    },
  };
  const output = text(tool.renderResult!(result, options, theme, context(presets[name].args)));
  expect(output).toContain("old.ts");
  expect(output).toContain("next.ts");
  expect(output).not.toContain("model-facing text");
  expect(output).toContain("limit reached");
});

it("renders an incomplete streamed edit title without throwing", () => {
  const { tool } = capture("edit");
  // During argument streaming, runtime input is legitimately less complete than the schema.
  const args = { path: "file.txt" } as Parameters<NonNullable<Tools["edit"]["renderCall"]>>[0];
  const output = text(tool.renderCall!(args, theme, context(args, { isPartial: true })));
  expect(output).toContain("edit file.txt (0 edits)");
});

it("preserves find directory grouping and ls tree markers", () => {
  const find = capture("find").tool;
  const result = {
    content: [{ type: "text" as const, text: "src/a.ts\nroot.ts\nsrc/b.ts" }],
    details: undefined,
  };
  const output = text(find.renderResult!(result, options, theme, context(presets.find.args)));
  expect(output).toContain("src/\n  ├── a.ts\n  └── b.ts\n\n./\n  └── root.ts");
  const ls = capture("ls").tool;
  const listing = text(
    ls.renderResult!(
      { content: [{ type: "text", text: "one/\ntwo.txt" }], details: undefined },
      options,
      theme,
      context({}),
    ),
  );
  expect(listing).toContain("├── one/\n└── two.txt");
});

it.each(["ls", "find"] as const)(
  "keeps %s tree/group formatting for extensionless and whitespace names",
  (name) => {
    const tool = erased(capture(name).tool);
    const result = {
      content: [{ type: "text" as const, text: "LICENSE\r\nmy file\r" }],
      details: undefined,
    };
    const output = text(tool.renderResult!(result, options, theme, context(presets[name].args)));
    expect(output).toContain("├── LICENSE");
    expect(output).toContain("└── my file");
    expect(output).toContain(name === "ls" ? "2 entries" : "2 files");
  },
);

it("keeps unfamiliar grep output visible with a bounded collapsed preview", () => {
  const tool = erased(capture("grep").tool);
  const result = { content: [{ type: "text" as const, text: rows }], details: undefined };
  const ctx = context(presets.grep.args);
  const collapsed = tool.renderResult!(result, options, theme, ctx);
  const output = text(collapsed);
  expect(output).toContain("row-3");
  expect(output).not.toContain("row-4");
  expect(output).not.toContain("0 matches");
  expect(output).toContain("output · collapsed · 11 hidden");
  expect(collapsed.render(180)).toHaveLength(4);
  const expanded = tool.renderResult!(result, { ...options, expanded: true }, theme, {
    ...ctx,
    lastComponent: collapsed,
  });
  expect(text(expanded)).toContain("row-14");
});

it("keeps empty searches and directories distinct from errors", () => {
  const grep = capture("grep").tool;
  const noMatches = {
    content: [{ type: "text" as const, text: "No matches found" }],
    details: { matchLimitReached: 1, truncation: truncateHead("one\ntwo", { maxLines: 1 }) },
  };
  expect(text(grep.renderResult!(noMatches, options, theme, context(presets.grep.args)))).toContain(
    "0 matches · limit reached · truncated",
  );
  const find = capture("find").tool;
  expect(
    text(
      find.renderResult!(
        {
          content: [{ type: "text", text: "No files found matching pattern" }],
          details: undefined,
        },
        options,
        theme,
        context(presets.find.args),
      ),
    ),
  ).toContain("0 files");
  const ls = capture("ls").tool;
  expect(
    text(
      ls.renderResult!(
        { content: [{ type: "text", text: "(empty directory)" }], details: undefined },
        options,
        theme,
        context({}),
      ),
    ),
  ).toContain("0 entries");
});
