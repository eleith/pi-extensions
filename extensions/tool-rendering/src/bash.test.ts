import { rmSync } from "node:fs";
import * as agent from "@earendil-works/pi-coding-agent";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBashRendering } from "./bash.ts";
import { FramedText } from "./frame.ts";
import { RenderingState } from "./state.ts";

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "bash-rendering-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});

agent.initTheme("dark", false);

type Tool = ReturnType<typeof agent.createBashToolDefinition>;
type RenderResult = NonNullable<Tool["renderResult"]>;
type Context = Parameters<RenderResult>[3];
type Options = Parameters<RenderResult>[1];
const theme = {
  fg: vi.fn((_color: ThemeColor, text: string) => text),
  bold: (text: string) => text,
} as unknown as Parameters<RenderResult>[2];
const collapsed: Options = { expanded: false, isPartial: false };
const partial: Options = { expanded: false, isPartial: true };
function context(overrides: Partial<Context> = {}): Context {
  return {
    args: { command: "echo test" },
    toolCallId: "call",
    cwd: scratch,
    invalidate: vi.fn(),
    lastComponent: undefined,
    state: { startedAt: undefined, endedAt: undefined, interval: undefined },
    executionStarted: false,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 0,
    ...overrides,
  };
}
function result(text: string): Parameters<RenderResult>[0] {
  return { content: [{ type: "text", text }], details: undefined };
}
function fixture() {
  const state = new RenderingState();
  states.push(state);
  const tool = buildBashRendering(state);
  if (!tool.renderCall || !tool.renderResult) throw new Error("Missing bash renderers");
  return { state, tool, call: tool.renderCall, render: tool.renderResult };
}
const states: RenderingState[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  vi.clearAllMocks();
});
afterEach(() => {
  for (const state of states.splice(0)) state.bashTiming.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe("bash renderers", () => {
  it("builds presentation only, without execution, schemas or eager timers", () => {
    const { tool } = fixture();
    expect(Object.keys(tool)).toEqual(["renderShell", "renderCall", "renderResult"]);
    expect(tool.renderShell).toBe("self");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("previews the first five command lines and all lines when expanded", () => {
    const { call } = fixture();
    const args = {
      command: "printf a\nprintf b\nprintf c\nprintf d\nprintf e\nprintf f\nprintf g",
      timeout: 10,
    };
    const ctx = context({ args, isPartial: true });
    const component = call(args, theme, ctx);
    const lines = component.render(100);
    expect(lines[0]).toContain("bash printf (10s timeout)");
    expect(lines.slice(1, 6).map((line) => line.trimEnd())).toEqual([
      "$ printf a",
      "> printf b",
      "> printf c",
      "> printf d",
      "> printf e",
    ]);
    expect(lines[6]).toContain("2 more lines");
    const expanded = call(args, theme, { ...ctx, lastComponent: component, expanded: true });
    expect(expanded).toBe(component);
    expect(expanded.render(100).join("\n")).toContain("> printf g");
    expect(expanded.render(100).join("\n")).not.toContain("more lines");
  });

  it("uses the first nonempty command word and preserves the empty-command fallback", () => {
    const { call } = fixture();
    expect(call({ command: "\n  echo hi | cat" }, theme, context()).render(80)[0]).toContain(
      "bash echo",
    );
    const blank = call({ command: " \n" }, theme, context()).render(80).join("\n");
    expect(blank).toContain("bash command");
    expect(blank).not.toContain("$ ");
  });

  it("previews the last five output lines, excludes one trailing newline, and expands", () => {
    const { render } = fixture();
    const ctx = context();
    const output = result("one\ntwo\nthree\nfour\nfive\nsix\nseven\r\n");
    const component = render(output, collapsed, theme, ctx);
    const lines = component.render(100);
    expect(lines.slice(0, -1).map((line) => line.trimEnd())).toEqual([
      "three",
      "four",
      "five",
      "six",
      "seven",
    ]);
    expect(lines.at(-1)).toContain("✓ exit 0 · collapsed · 2 hidden");
    const expanded = render(output, { ...collapsed, expanded: true }, theme, {
      ...ctx,
      lastComponent: component,
    });
    expect(expanded).toBe(component);
    expect(
      expanded
        .render(100)
        .slice(0, -1)
        .map((line) => line.trimEnd()),
    ).toEqual(["one", "two", "three", "four", "five", "six", "seven"]);
    expect(expanded.render(100).at(-1)).toContain("✓ exit 0 · expanded");
  });

  it.each(["Command exited with code 9", "Command timed out after 10 seconds", "Command aborted"])(
    "preserves status-looking stdout in success and partial: %s",
    (status) => {
      const { render } = fixture();
      const output = result(`stdout\n\n${status}`);
      const done = render(output, collapsed, theme, context()).render(120).join("\n");
      expect(done).toContain(status);
      expect(done).toContain("✓ exit 0");
      const running = render(output, partial, theme, context({ isPartial: true }))
        .render(120)
        .join("\n");
      expect(running).toContain(status);
      expect(running).toContain("running");
      expect(running).not.toContain("✓ exit");
    },
  );

  it.each([
    ["Command exited with code 7", "✗ exit 7"],
    ["Command timed out after 12 seconds", "⚡ timed out"],
    ["Command aborted", "⚡ aborted"],
  ])("parses only error status tails: %s", (status, summary) => {
    const { render } = fixture();
    const text = render(
      result(`failed\n\n${status}\n`),
      collapsed,
      theme,
      context({ isError: true }),
    )
      .render(120)
      .join("\n");
    expect(text).toContain("failed");
    expect(text).toContain(summary);
    expect(text).not.toContain(status);
    expect(theme.fg).toHaveBeenCalledWith("error", "failed");
  });

  it("keeps unrecognized errors and nonterminal status text intact", () => {
    const { render } = fixture();
    const output = "Command exited with code 2\nmore output";
    const text = render(result(output), collapsed, theme, context({ isError: true }))
      .render(100)
      .map((line) => line.trimEnd())
      .join("\n");
    expect(text).toContain(output);
    expect(text).toContain("✗ error");
    expect(
      render(result("Command aborted"), collapsed, theme, context({ isError: true }))
        .render(100)
        .join("\n"),
    ).toContain("⚡ aborted");
  });

  it("renders text blocks, ignores images and structured output of unknown shape", () => {
    const { render } = fixture();
    const structuredContent: Parameters<RenderResult>[0]["structuredContent"] = {
      output: "not visible",
      nested: [42, null],
    };
    const output: Parameters<RenderResult>[0] = {
      content: [
        { type: "text", text: "first" },
        { type: "image", data: "unused", mimeType: "image/png" },
        { type: "text", text: "second" },
      ],
      details: undefined,
      structuredContent,
    };
    const text = render(output, collapsed, theme, context())
      .render(100)
      .map((line) => line.trimEnd())
      .join("\n");
    expect(text).toContain("first\nsecond");
    expect(text).not.toContain("not visible");
    expect(text).not.toContain("unused");
  });

  it("uses actual painter widths on call/result and terminal resize", () => {
    const { call, render } = fixture();
    const component = call({ command: "echo hello" }, theme, context());
    expect(component).toBeInstanceOf(FramedText);
    for (const width of [1, 5, 20, 70, 240]) {
      expect(visibleWidth(component.render(width)[0]!.trimEnd())).toBe(Math.min(width, 210));
    }
    const output = render(result("x".repeat(200)), collapsed, theme, context());
    for (const width of [1, 5, 30, 100]) {
      const lines = output.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(visibleWidth(lines.at(-1)!)).toBe(width);
    }
  });

  it("updates timing only on renderer calls, draws live partial elapsed, and freezes final duration", () => {
    const { state, render } = fixture();
    const update = vi.spyOn(state.bashTiming, "update");
    const ctx = context({ executionStarted: true, isPartial: true });
    const component = render(result(""), partial, theme, ctx);
    expect(component.render(100).join("\n")).toContain(
      "0.0s · running · no output yet · collapsed",
    );
    vi.advanceTimersByTime(2300);
    expect(component.render(80).join("\n")).toContain("2.3s");
    expect(update).toHaveBeenCalledTimes(1);
    expect(ctx.invalidate).toHaveBeenCalledTimes(2);
    state.bashTiming.stop(ctx.toolCallId);
    vi.advanceTimersByTime(5000);
    const final = render(result("done"), { ...collapsed, expanded: true }, theme, {
      ...ctx,
      isPartial: false,
      lastComponent: component,
    });
    expect(final.render(100).join("\n")).toContain("2.3s · ✓ exit 0 · expanded");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [61000, "1m1s"],
    [3600000, "1h"],
    [3660000, "1h1m"],
  ])("retains original long-duration formatting: %s", (ms, expected) => {
    const { state, render } = fixture();
    const ctx = context({ executionStarted: true, isPartial: true });
    render(result(""), partial, theme, ctx);
    vi.setSystemTime(1000 + ms);
    state.bashTiming.stop(ctx.toolCallId);
    const text = render(result("done"), collapsed, theme, { ...ctx, isPartial: false })
      .render(100)
      .join("\n");
    expect(text).toContain(`${expected} · ✓ exit 0`);
  });

  it("keeps an already selected framed renderer and its timer active after hide", () => {
    const { state, render } = fixture();
    const ctx = context({ executionStarted: true, isPartial: true });
    const framed = render(result("stream"), partial, theme, ctx);
    state.enabled = false;
    vi.advanceTimersByTime(1500);
    const updated = render(result("stream"), partial, theme, { ...ctx, lastComponent: framed });
    expect(updated).toBe(framed);
    expect(updated.render(100).join("\n")).toContain("1.5s · running");
    expect(ctx.invalidate).toHaveBeenCalledTimes(1);
    state.bashTiming.stop(ctx.toolCallId);
    expect(vi.getTimerCount()).toBe(0);
  });
});
