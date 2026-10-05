import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  bottomLeftStatus,
  contextLabel,
  extensionStatusLabel,
  gitLabel,
  modelLabel,
  styleThinking,
  thinkingLabel,
  topRightStatus,
} from "./format.ts";
import type { GitStatus, ThemeLike } from "./types.ts";

// Only formatter inputs, not a model registry, provider, or live Pi session.
type ModelContext = Parameters<typeof topRightStatus>[0];
type Usage = ReturnType<ExtensionContext["getContextUsage"]>;

function model(
  fields: Partial<
    Pick<NonNullable<ExtensionContext["model"]>, "name" | "id" | "contextWindow">
  > = {},
): NonNullable<ExtensionContext["model"]> {
  return { name: "gpt-5", id: "fallback-id", contextWindow: 128_000, ...fields } as NonNullable<
    ExtensionContext["model"]
  >;
}

function context(overrides: Partial<ModelContext> = {}): ModelContext {
  return {
    model: model(),
    thinkingLevel: "high",
    getContextUsage: vi.fn((): Usage => ({
      tokens: 12_000,
      contextWindow: 128_000,
      percent: 9.375,
    })),
    ...overrides,
  };
}

function withUsage(usage: Usage, currentModel = model()): ModelContext {
  return context({ model: currentModel, getContextUsage: vi.fn(() => usage) });
}

function folder(cwd = "/work/project"): ExtensionContext {
  // bottomLeftStatus reads only cwd from the root context.
  return { cwd } as ExtensionContext;
}

function theme(ansiColor?: number) {
  const fg = vi.fn<ThemeLike["fg"]>((_color, text) =>
    ansiColor === undefined ? text : `\x1b[${ansiColor}m${text}\x1b[39m`,
  );
  const bold = vi.fn<ThemeLike["bold"]>((text) =>
    ansiColor === undefined ? text : `\x1b[1m${text}\x1b[22m`,
  );
  return { fg, bold } satisfies ThemeLike;
}

const clean: GitStatus = { staged: 0, unstaged: 0, untracked: 0 };

const thinkingCases = [
  [undefined, "Off", "dim", false],
  ["off", "Off", "dim", false],
  ["minimal", "Minimal", "muted", false],
  ["low", "Low", "success", true],
  ["medium", "Medium", "accent", true],
  ["high", "High", "warning", true],
  ["xhigh", "Extra high", "thinkingXhigh", true],
  ["max", "Maximum", "thinkingMax", true],
] as const;

describe("thinking labels and styling", () => {
  it.each(thinkingCases)("formats %s as %s with %s styling", (level, label, color, bold) => {
    const currentTheme = theme(36);
    expect(thinkingLabel(level)).toBe(label);
    const result = styleThinking(currentTheme, level, label);
    const colored = `\x1b[36m${label}\x1b[39m`;
    expect(currentTheme.fg).toHaveBeenCalledExactlyOnceWith(color, label);
    expect(result).toBe(bold ? `\x1b[1m${colored}\x1b[22m` : colored);
    if (bold) expect(currentTheme.bold).toHaveBeenCalledExactlyOnceWith(colored);
    else expect(currentTheme.bold).not.toHaveBeenCalled();
  });
});

describe("modelLabel", () => {
  it.each([
    [undefined, "no model"],
    [model({ name: "", id: "" }), "no model"],
    [model({ name: "", id: "gPt-5-mini" }), "GPT-5-mini"],
    [model({ name: "GPT-5", id: "ignored" }), "GPT-5"],
    [model({ name: "Claude 智", id: "ignored" }), "Claude 智"],
    [model({ name: "custom-gpt-5" }), "custom-gpt-5"],
  ])("selects and normalizes the display label: %s", (currentModel, expected) => {
    expect(modelLabel(currentModel)).toBe(expected);
  });
});

describe("contextLabel", () => {
  it.each([
    [null, "muted"],
    [NaN, "muted"],
    [Infinity, "muted"],
    [-Infinity, "muted"],
    [0, "muted"],
    [49.99, "muted"],
    [50, "accent"],
    [74.99, "accent"],
    [75, "warning"],
    [89.99, "warning"],
    [90, "error"],
    [100, "error"],
  ] as const)("uses reported percent %s for %s styling", (percent, color) => {
    const currentTheme = theme(33);
    const ctx = withUsage({ tokens: 12_000, contextWindow: 128_000, percent });
    expect(stripTerminalSequences(contextLabel(ctx, currentTheme))).toBe("Context: 12k/128k");
    expect(ctx.getContextUsage).toHaveBeenCalledTimes(1);
    expect(currentTheme.fg.mock.calls).toEqual([
      [color, "Context: "],
      [color, "12k/128k"],
    ]);
    if (color === "muted") expect(currentTheme.bold).not.toHaveBeenCalled();
    else expect(currentTheme.bold).toHaveBeenCalledExactlyOnceWith("\x1b[33m12k/128k\x1b[39m");
  });

  it("uses the model window when usage is unavailable, without inventing zero tokens", () => {
    expect(contextLabel(withUsage(undefined), theme())).toBe("Context: unknown/128k");
    expect(
      contextLabel(context({ model: undefined, getContextUsage: () => undefined }), theme()),
    ).toBe("Context: unknown/unknown");
  });

  it("uses the reported window ahead of the model and does not require a model", () => {
    const usage = { tokens: 12_345, contextWindow: 1_250_000, percent: null };
    expect(contextLabel(withUsage(usage), theme())).toBe("Context: 12k/1m");
    expect(contextLabel(context({ model: undefined, getContextUsage: () => usage }), theme())).toBe(
      "Context: 12k/1m",
    );
  });

  it("preserves zero tokens, zero window, and zero percent", () => {
    const currentTheme = theme();
    expect(contextLabel(withUsage({ tokens: 0, contextWindow: 0, percent: 0 }), currentTheme)).toBe(
      "Context: 0/0",
    );
    expect(currentTheme.fg).toHaveBeenCalledWith("muted", "0/0");
    expect(currentTheme.bold).not.toHaveBeenCalled();
  });

  it.each([null, -1, NaN, Infinity, -Infinity])(
    "reports invalid tokens %s as unknown",
    (tokens) => {
      expect(
        contextLabel(withUsage({ tokens, contextWindow: 128_000, percent: null }), theme()),
      ).toBe("Context: unknown/128k");
    },
  );

  it.each([-1, NaN, Infinity, -Infinity])(
    "does not substitute the model for invalid window %s",
    (window) => {
      expect(
        contextLabel(withUsage({ tokens: 1000, contextWindow: window, percent: null }), theme()),
      ).toBe("Context: 1k/unknown");
    },
  );
});

describe("topRightStatus", () => {
  const full = " GPT-5 | Thinking: High | Context: 12k/128k ";
  const compact = " Thinking: High | Context: 12k/128k ";
  const contextOnly = " Context: 12k/128k ";

  it("includes model, thinking, and context with padding at unlimited width", () => {
    expect(topRightStatus(context(), theme(), "|")).toBe(full);
  });

  it.each([
    [visibleWidth(full), full],
    [visibleWidth(full) - 1, compact],
    [visibleWidth(compact), compact],
    [visibleWidth(compact) - 1, contextOnly],
    [1, contextOnly],
  ])("selects full, compact, or context-only at width %s", (width, expected) => {
    const result = topRightStatus(context(), theme(36), "|", width);
    expect(stripTerminalSequences(result)).toBe(expected);
    // The widget, not this formatter, truncates a context label that still overflows.
    if (width === 1) expect(visibleWidth(result)).toBeGreaterThan(width);
  });

  it("uses visible Unicode width rather than string length for fallbacks", () => {
    const ctx = context({ model: model({ name: "模型🧠" }) });
    const expected = " 模型🧠 · Thinking: High · Context: 12k/128k ";
    const width = visibleWidth(expected);
    expect(stripTerminalSequences(topRightStatus(ctx, theme(35), "·", width))).toBe(expected);
    expect(stripTerminalSequences(topRightStatus(ctx, theme(35), "·", width - 1))).toBe(
      " Thinking: High · Context: 12k/128k ",
    );
  });

  it("keeps explicit unknown and zero usage labels in the narrow fallback", () => {
    expect(topRightStatus(withUsage(undefined), theme(), "|", 1)).toBe(" Context: unknown/128k ");
    expect(
      topRightStatus(
        withUsage({ tokens: null, contextWindow: 128_000, percent: null }),
        theme(),
        "|",
        1,
      ),
    ).toBe(" Context: unknown/128k ");
    expect(
      topRightStatus(withUsage({ tokens: 0, contextWindow: 128_000, percent: 0 }), theme(), "|", 1),
    ).toBe(" Context: 0/128k ");
  });
});

describe("extensionStatusLabel", () => {
  it("omits absent, empty, and whitespace-only statuses", () => {
    expect(extensionStatusLabel(undefined)).toBe("");
    expect(extensionStatusLabel(new Map())).toBe("");
    expect(extensionStatusLabel(new Map([["empty", " \x1b[31m \x1b[0m\t"]]))).toBe("");
  });

  it("strips ANSI colors, trims values, and preserves insertion order and Unicode", () => {
    const statuses = new Map([
      ["z-context", " \x1b[1;33mContext: 12k/128k\x1b[0m "],
      ["empty", ""],
      ["a-task", "\x1b[32m作業 🧠\x1b[39m"],
    ]);
    expect(extensionStatusLabel(statuses)).toBe("Context: 12k/128k › 作業 🧠");
    expect(statuses.get("z-context")).toContain("\x1b[1;33m");
  });
});

describe("gitLabel", () => {
  it.each([null, ""])("omits git without a branch (%s), even with changes", (branch) => {
    expect(gitLabel(branch, { staged: 1, unstaged: 2, untracked: 3 })).toBe("");
  });

  it("distinguishes an unknown status from a known clean tree", () => {
    expect(gitLabel("main", null)).toBe("Git: main");
    expect(gitLabel("main", clean)).toBe("Git: main › clean");
  });

  it.each([
    [{ staged: 1, unstaged: 0, untracked: 0 }, "1 staged change"],
    [{ staged: 0, unstaged: 1, untracked: 0 }, "1 unstaged change"],
    [{ staged: 0, unstaged: 0, untracked: 1 }, "1 untracked file"],
    [
      { staged: 2, unstaged: 3, untracked: 4 },
      "2 staged changes › 3 unstaged changes › 4 untracked files",
    ],
  ])("formats nonzero counts in staged/unstaged/untracked order: %j", (status, expected) => {
    expect(gitLabel("feature/模型", status)).toBe(`Git: feature/模型 › ${expected}`);
  });
});

describe("bottomLeftStatus", () => {
  const statuses = new Map([["context", "\x1b[33m Context: 12k/128k \x1b[0m"]]);
  const full = " Context: 12k/128k | project | Git: main › clean ";
  const split = [" Context: 12k/128k | project ", " Git: main › clean "];

  it("combines extension statuses, the folder basename, and git at unlimited width", () => {
    const currentTheme = theme();
    expect(bottomLeftStatus(folder(), statuses, "main", clean, currentTheme, "|")).toEqual([full]);
    expect(currentTheme.fg).toHaveBeenCalledExactlyOnceWith("dim", full);
    expect(currentTheme.bold).not.toHaveBeenCalled();
  });

  it.each([
    [visibleWidth(full), [full]],
    [visibleWidth(full) - 1, split],
    [1, split],
  ])("splits only git onto the second line at width %s", (width, expected) => {
    const currentTheme = theme(34);
    const lines = bottomLeftStatus(folder(), statuses, "main", clean, currentTheme, "|", width);
    expect(lines.map(stripTerminalSequences)).toEqual(expected);
    expect(currentTheme.fg.mock.calls).toEqual(expected.map((line) => ["dim", line]));
  });

  it("keeps one untruncated line without git, even at narrow width", () => {
    expect(bottomLeftStatus(folder(), undefined, null, null, theme(), "|", 1)).toEqual([
      " project ",
    ]);
    expect(bottomLeftStatus(folder(), statuses, null, clean, theme(), "|", 1)).toEqual([
      " Context: 12k/128k | project ",
    ]);
  });

  it("omits empty status sections and uses the process folder for empty cwd", () => {
    expect(
      bottomLeftStatus(folder(""), new Map([["blank", " "]]), "main", null, theme(), "·"),
    ).toEqual([` ${basename(process.cwd())} · Git: main `]);
  });

  it("measures ANSI-colored Unicode folder, statuses, and branch at the split boundary", () => {
    const ctx = folder("/work/模型");
    const unicodeStatuses = new Map([["task", "\x1b[32m🧠 ready\x1b[0m"]]);
    const expected = " 🧠 ready · 模型 · Git: 功能 › clean ";
    const width = visibleWidth(expected);
    expect(
      bottomLeftStatus(ctx, unicodeStatuses, "功能", clean, theme(32), "·", width).map(
        stripTerminalSequences,
      ),
    ).toEqual([expected]);
    expect(
      bottomLeftStatus(ctx, unicodeStatuses, "功能", clean, theme(32), "·", width - 1).map(
        stripTerminalSequences,
      ),
    ).toEqual([" 🧠 ready · 模型 ", " Git: 功能 › clean "]);
  });
});

describe("per-render themes and live inputs", () => {
  it("uses the supplied theme on each call rather than caching styled chrome", () => {
    const firstTheme = theme(31);
    const nextTheme = theme(36);
    const ctx = context();
    const firstTop = topRightStatus(ctx, firstTheme, "|");
    const nextTop = topRightStatus(ctx, nextTheme, "|");
    const firstBottom = bottomLeftStatus(folder(), undefined, "main", clean, firstTheme, "|");
    const nextBottom = bottomLeftStatus(folder(), undefined, "main", clean, nextTheme, "|");
    expect(nextTop).not.toBe(firstTop);
    expect(stripTerminalSequences(nextTop)).toBe(stripTerminalSequences(firstTop));
    expect(nextBottom).not.toEqual(firstBottom);
    expect(nextBottom.map(stripTerminalSequences)).toEqual(firstBottom.map(stripTerminalSequences));
    expect(nextTop).toContain("\x1b[36m");
    expect(nextTop).not.toContain("\x1b[31m");
    expect(nextTheme.fg).toHaveBeenCalledWith("warning", "High");
    expect(nextTheme.fg).toHaveBeenCalledWith("dim", " project | Git: main › clean ");
  });

  it("re-reads context usage and status values on the next format call", () => {
    const getContextUsage = vi
      .fn<ExtensionContext["getContextUsage"]>()
      .mockReturnValueOnce({ tokens: null, contextWindow: 128_000, percent: null })
      .mockReturnValueOnce({ tokens: 115_000, contextWindow: 128_000, percent: 90 });
    const ctx = context({ getContextUsage });
    const currentTheme = theme();
    expect(topRightStatus(ctx, currentTheme, "|", 1)).toBe(" Context: unknown/128k ");
    expect(topRightStatus(ctx, currentTheme, "|", 1)).toBe(" Context: 115k/128k ");
    expect(currentTheme.fg).toHaveBeenCalledWith("error", "115k/128k");
    expect(getContextUsage).toHaveBeenCalledTimes(2);

    const statuses = new Map([["context", "Context: unknown/128k"]]);
    expect(bottomLeftStatus(folder(), statuses, null, null, currentTheme, "|")).toEqual([
      " Context: unknown/128k | project ",
    ]);
    statuses.set("context", "Context: 115k/128k");
    expect(bottomLeftStatus(folder(), statuses, null, null, currentTheme, "|")).toEqual([
      " Context: 115k/128k | project ",
    ]);
  });
});
