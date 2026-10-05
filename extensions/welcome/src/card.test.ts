import { VERSION, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomeCard } from "./card.ts";
import { treeVariants } from "./tree.ts";
import { ENTRY_TYPE, type WelcomeData } from "./types.ts";

type CardTheme = Pick<Theme, "fg" | "bold">;

// Only the two documented theme methods consumed by the component.
function colorTheme(color = 36) {
  return {
    fg: vi.fn<CardTheme["fg"]>((_token, text) => `\x1b[${color}m${text}\x1b[39m`),
    bold: vi.fn<CardTheme["bold"]>((text) => `\x1b[1m${text}\x1b[22m`),
  } satisfies CardTheme;
}

function data(overrides: Partial<WelcomeData> = {}): WelcomeData {
  return {
    directory: "~/work/project",
    branch: "main · modified",
    session: "Planning",
    model: "provider / model",
    contextWindow: 128_000,
    thinking: "high",
    context: "AGENTS.md",
    skills: "review, test",
    prompts: "/explain",
    tools: "4 active / 8 available",
    ...overrides,
  };
}

function plain(card: WelcomeCard, width: number): string[] {
  return card.render(width).map(stripTerminalSequences);
}

beforeEach(() => vi.stubEnv("NONO_CAP_FILE", undefined));
afterEach(() => vi.unstubAllEnvs());

describe("WelcomeCard layout", () => {
  it.each(["auto", "large", "small", "tiny"] as const)(
    "%s stays within terminal columns, including Unicode and narrow fallback widths",
    (treeSize) => {
      const card = new WelcomeCard(
        data({
          treeSize,
          directory: "~/模型/🧠".repeat(30),
          branch: "功能".repeat(60),
          model: "provider / e\u0301模型🧠".repeat(20),
          skills: "技能🧠".repeat(60),
        }),
        colorTheme(),
      );
      for (const width of [
        1, 2, 4, 5, 6, 20, 23, 24, 33, 34, 40, 52, 66, 67, 76, 77, 80, 94, 95, 120,
      ]) {
        const lines = card.render(width);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines)
          expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
      }
      expect(plain(card, 1)).toEqual(["p"]);
      expect(plain(card, 4)).toEqual(["pi"]);
      expect(plain(card, 5)[0]).toBe("─────");
      expect(plain(card, 6)[0]).toBe("── pi ");
      expect(plain(card, 20).join("\n")).not.toMatch(/[█▀▄]/u);
    },
  );

  it("preserves the stacked details, two-column padding, full title and borders", () => {
    const lines = plain(new WelcomeCard(data(), colorTheme()), 20);
    expect(lines).toEqual([
      `── pi / v${VERSION} ` + "─".repeat(20 - visibleWidth(`── pi / v${VERSION} `)),
      "",
      "  [ Workspace ]",
      "  ~/work/project",
      "  main · modified…",
      "  ",
      "  [ Provider ]",
      "  provider / model",
      "  high thinking  …",
      "  ",
      "  [ Resources ]",
      "  Agents   AGENTS…",
      "  Skills   review…",
      "  Prompts  /expla…",
      "  Tools    4 acti…",
      "  ",
      "  Type / for comm…",
      "",
      "─".repeat(20),
    ]);
  });

  it.each([
    [23, undefined],
    [24, "tiny"],
    [33, "tiny"],
    [34, "small"],
    [40, "small"],
    [76, "small"],
    [77, "small"],
    [80, "small"],
    [94, "small"],
    [95, "large"],
    [120, "large"],
  ] as const)("auto chooses the original variant at width %s", (width, size) => {
    const lines = new WelcomeCard(data(), colorTheme()).render(width);
    const art = lines.filter((line) => /[█▀▄]/u.test(line));
    if (!size) {
      expect(art).toEqual([]);
      return;
    }
    const tree = treeVariants[size];
    const sideBySide = width - 4 >= tree.width + 3 + 40;
    const indent = " ".repeat(sideBySide ? 2 : Math.floor((width - tree.width) / 2));
    for (const line of tree.lines.filter((line) => /[█▀▄]/u.test(line))) {
      expect(art.some((rendered) => rendered.startsWith(indent + line))).toBe(true);
    }
    const workspace = lines.find((line) => stripTerminalSequences(line).includes("[ Workspace ]"))!;
    if (sideBySide) {
      const text = stripTerminalSequences(workspace);
      expect(text.indexOf("[ Workspace ]")).toBe(2 + tree.width + 3);
      expect(lines).toHaveLength(Math.max(tree.lines.length, 15) + 4);
    } else {
      expect(stripTerminalSequences(workspace)).toBe("  [ Workspace ]");
      expect(lines).toHaveLength(tree.lines.length + 1 + 15 + 4);
    }
  });

  it.each([
    ["large", 52, "large"],
    ["large", 80, "large"],
    ["large", 40, "small"],
    ["small", 120, "small"],
    ["small", 24, "tiny"],
    ["tiny", 120, "tiny"],
    ["tiny", 24, "tiny"],
  ] as const)(
    "honors %s at width %s, falling back only if it cannot fit",
    (size, width, selected) => {
      const lines = new WelcomeCard(data({ treeSize: size }), colorTheme()).render(width);
      const tree = treeVariants[selected];
      const sideBySide = width - 4 >= tree.width + 3 + 40;
      const indent = " ".repeat(sideBySide ? 2 : Math.floor((width - tree.width) / 2));
      const sample = tree.lines.find((line) => /[█▀▄]/u.test(line))!;
      expect(lines.some((line) => line.startsWith(indent + sample))).toBe(true);
      expect(lines).toHaveLength(
        sideBySide ? Math.max(tree.lines.length, 15) + 4 : tree.lines.length + 20,
      );
    },
  );

  it("centers the tiny tree vertically alongside details, and details alongside the large tree", () => {
    const tiny = new WelcomeCard(data({ treeSize: "tiny" }), colorTheme()).render(67);
    expect(tiny[2 + 2]).toContain(treeVariants.tiny.lines[0]);
    expect(stripTerminalSequences(tiny[2]).indexOf("[ Workspace ]")).toBe(25);
    const large = new WelcomeCard(data(), colorTheme()).render(120);
    expect(stripTerminalSequences(large[2 + 3]).indexOf("[ Workspace ]")).toBe(53);
    expect(large[2]).toBe(" ".repeat(53));
  });
});

describe("saved entries and render-time metadata", () => {
  it("renders the stored legacy entry without treeSize or optional provider metadata", () => {
    expect(ENTRY_TYPE).toBe("eleith-startup-tree");
    const stored = JSON.parse(
      JSON.stringify(data({ thinking: undefined, contextWindow: undefined })),
    ) as WelcomeData;
    const card = new WelcomeCard(stored, colorTheme());
    expect(card.render(80)).toEqual(
      new WelcomeCard({ ...stored, treeSize: "auto" }, colorTheme()).render(80),
    );
    expect(plain(card, 120).join("\n")).toContain("off thinking");
    expect(plain(card, 120).join("\n")).not.toContain("k context");
    expect(stored).not.toHaveProperty("treeSize");
  });

  it("sanitizes every stored text field before styling, including whitespace and Cc/Cf", () => {
    const dirty = " \u0000A\tB\nC\u007fD\u0085E\u200bF\u202eG\x1b[31m ";
    const theme = colorTheme();
    const card = new WelcomeCard(
      data({
        directory: dirty,
        branch: dirty,
        session: dirty,
        model: dirty,
        context: dirty,
        skills: dirty,
        prompts: dirty,
        tools: dirty,
        thinking: dirty as WelcomeData["thinking"],
      }),
      theme,
    );
    const output = plain(card, 120).join("\n");
    expect(output).toContain("A B C D E F G [31m");
    expect(output).toContain("off thinking");
    for (const [, text] of theme.fg.mock.calls) expect(text).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(
      theme.fg.mock.calls.filter(([, text]) => text.includes("A B C D E F G [31m")),
    ).toHaveLength(7);
  });

  it("handles malformed field values without coercion or invalid theme tokens", () => {
    const malformed = {
      directory: null,
      branch: {},
      session: [],
      model: 42,
      context: false,
      skills: undefined,
      prompts: {},
      tools: [],
      thinking: "__proto__",
      contextWindow: "128000\x1b[31m",
      treeSize: "__proto__",
    } as unknown as WelcomeData;
    const theme = colorTheme();
    const card = new WelcomeCard(malformed, theme);
    expect(() => card.render(120)).not.toThrow();
    const text = plain(card, 120).join("\n");
    expect(text).toContain("off thinking");
    expect(text).not.toMatch(/undefined|null|object|128000|__proto__/u);
    expect(theme.fg.mock.calls.every(([token]) => typeof token === "string")).toBe(true);
    for (const contextWindow of [NaN, Infinity, -1, 0]) {
      expect(
        plain(new WelcomeCard(data({ contextWindow }), colorTheme()), 120).join("\n"),
      ).not.toContain("k context");
    }
  });

  it("hides placeholder sessions and converts legacy resource dashes to zero found", () => {
    for (const session of ["", "new session", "unnamed session", " \nnew session\u200b "]) {
      const card = new WelcomeCard(
        data({ session, branch: undefined, context: " — " }),
        colorTheme(),
      );
      const lines = plain(card, 120);
      expect(lines.join("\n")).not.toContain("session");
      expect(lines.join("\n")).toContain("Agents   0 found");
      expect(lines).toHaveLength(26); // large tree determines height even with fewer facts
    }
  });

  it("reads Boolean NONO_CAP_FILE on each render, without exposing or reading the file", () => {
    const card = new WelcomeCard(data(), colorTheme());
    expect(plain(card, 120).join("\n")).not.toContain("nono sandbox");
    vi.stubEnv("NONO_CAP_FILE", "/does/not/exist/capabilities.json\x1b[31m");
    const sandboxed = plain(card, 120).join("\n");
    expect(sandboxed).toContain("main · modified  ·  nono sandbox  ·  Planning");
    expect(sandboxed).not.toContain("capabilities.json");
    vi.stubEnv("NONO_CAP_FILE", "");
    expect(plain(card, 120).join("\n")).not.toContain("nono sandbox");
    vi.stubEnv("NONO_CAP_FILE", "0");
    expect(plain(card, 120).join("\n")).toContain("nono sandbox");
    vi.stubEnv("NONO_CAP_FILE", undefined);
    expect(plain(card, 120).join("\n")).not.toContain("nono sandbox");
  });
});

describe("theme and provider styling", () => {
  it.each([
    ["off", "dim", false],
    ["minimal", "muted", false],
    ["low", "success", true],
    ["medium", "accent", true],
    ["high", "warning", true],
    ["xhigh", "thinkingXhigh", true],
    ["max", "thinkingMax", true],
  ] as const)("styles %s thinking through the shared helper", (thinking, token, bold) => {
    const theme = colorTheme();
    const lines = new WelcomeCard(data({ thinking }), theme).render(120);
    expect(theme.fg).toHaveBeenCalledWith(token, thinking);
    if (bold) expect(theme.bold).toHaveBeenCalledWith(`\x1b[36m${thinking}\x1b[39m`);
    else expect(theme.bold).not.toHaveBeenCalledWith(`\x1b[36m${thinking}\x1b[39m`);
    expect(lines.map(stripTerminalSequences).join("\n")).toContain(
      `${thinking} thinking  ·  128k context`,
    );
    expect(theme.fg).toHaveBeenCalledWith("mdHeading", "[ Workspace ]");
    expect(theme.fg).toHaveBeenCalledWith("borderAccent", "─".repeat(120));
    expect(theme.bold).toHaveBeenCalledWith(`\x1b[36m pi / v${VERSION} \x1b[39m`);
  });

  it("rerenders with updated theme methods without recoloring the fixed artwork", () => {
    const theme = colorTheme(31);
    const card = new WelcomeCard(data(), theme);
    const first = card.render(80);
    theme.fg = colorTheme(36).fg;
    card.invalidate();
    const next = card.render(80);
    expect(next).not.toEqual(first);
    expect(next.map(stripTerminalSequences)).toEqual(first.map(stripTerminalSequences));
    expect(next.join("\n")).toContain("\x1b[36m");
    expect(next.join("\n")).not.toContain("\x1b[31m");
    expect(
      next.filter((line) => /[█▀▄]/u.test(line)).map((line) => line.split("\x1b[36m")[0]),
    ).toEqual(first.filter((line) => /[█▀▄]/u.test(line)).map((line) => line.split("\x1b[31m")[0]));
  });
});
