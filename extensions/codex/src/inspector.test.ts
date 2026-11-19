import { stripVTControlCharacters } from "node:util";
import { expect, it, vi } from "vitest";
import { TuiMainScreen, type OverlayOptions, type Terminal } from "@earendil-works/pi-tui";
import { customInteractionUI } from "./custom-interaction.test-helper.ts";
import { InspectorController, type InspectorHost } from "./inspector.ts";
import type { InspectorContent } from "./inspector-view.ts";

it.each(
  [1, 2, 3, 4, 5, 6, 7, 12, 24].flatMap((rows) => [
    { rows, loading: false },
    { rows, loading: true },
  ]),
)("keeps content and chrome inside the real Pi overlay host: %o", async ({ rows, loading }) => {
  const surface = customInteractionUI({ rows, columns: 100 });
  const inspector = new InspectorController();
  const terminal = {
    rows,
    columns: 100,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    drainInput: async () => {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
  } satisfies Terminal;
  const tui = new TuiMainScreen(terminal);
  tui.addChild({
    render: (width) => Array.from({ length: rows }, () => "X".repeat(width)),
    invalidate() {},
  });
  const ctx: InspectorHost = {
    mode: "tui",
    sessionManager: { getSessionId: () => "session" },
    ui: { custom: surface.custom, notify: vi.fn() },
  };
  const request = inspector.show(
    ctx,
    "Overview",
    loading
      ? { loading: "Fetching usage…", load: () => new Promise<InspectorContent>(() => {}) }
      : { message: Array.from({ length: 40 }, (_, index) => `Report row ${index}`).join("\n") },
  );
  let overlay: ReturnType<typeof tui.showOverlay> | undefined;
  try {
    await Promise.resolve();
    const component = surface.modals[0].component!;
    const configured = surface.custom.mock.calls[0][1]!.overlayOptions;
    const options: OverlayOptions = typeof configured === "function" ? configured() : configured!;
    // Exercise native overlay geometry/compositing, not only component.render().
    overlay = tui.showOverlay(component, options);
    // Reuse the mounted overlay through extreme horizontal resizes. Component-only
    // width checks cannot catch off-screen placement caused by host margins.
    for (const columns of [100, 76, 24, 5, 4, 3, 2, 1, 100]) {
      terminal.columns = columns;
      tui.renderNow(true);
      const bounds = overlay.getBounds()!;
      expect(bounds.row).toBeGreaterThanOrEqual(0);
      expect(bounds.row + bounds.height).toBeLessThanOrEqual(rows);
      expect(bounds.col).toBeGreaterThanOrEqual(0);
      expect(bounds.col + bounds.width).toBeLessThanOrEqual(columns);
      const screen = tui.captureRenderState().previousLines.map(stripVTControlCharacters);
      const inside = screen.slice(bounds.row, bounds.row + bounds.height).map((line) => {
        expect(line.slice(0, bounds.col)).toBe("X".repeat(bounds.col));
        expect(line.slice(bounds.col + bounds.width)).toBe(
          "X".repeat(columns - bounds.col - bounds.width),
        );
        return line.slice(bounds.col, bounds.col + bounds.width);
      });
      const framed = rows >= 5 && bounds.width >= 5;
      if (framed) {
        const rule = "─".repeat(bounds.width - 2);
        expect(inside[0]).toBe(`╭${rule}╮`);
        expect(inside.at(-1)).toBe(`╰${rule}╯`);
        for (const line of inside.slice(1, -1)) expect(line).toMatch(/^│[^X]*│$/u);
      } else {
        expect(inside.join("\n")).not.toMatch(/[╭╮╰╯│]/u);
      }
      if (columns === 100) {
        expect(inside.join("\n")).toContain(loading ? "cancel" : "close");
        if (rows >= 2) expect(inside.join("\n")).toContain("Codex · Overview");
        if (rows >= 3)
          expect(inside.join("\n")).toContain(loading ? "Fetching usage" : "Report row");
        if (framed) expect(inside[1]).toMatch(/^│ Codex · Overview +│$/u);
      }
    }
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    component.handleInput!("\u001b");
    await request;
  } finally {
    inspector.dispose();
    surface.dispose();
    overlay?.hide();
    tui.stop();
  }
});
