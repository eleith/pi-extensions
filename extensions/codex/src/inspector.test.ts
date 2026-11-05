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
    for (const columns of [100, 76, 24, 3, 2, 1, 100]) {
      terminal.columns = columns;
      tui.renderNow(true);
      const bounds = overlay.getBounds()!;
      expect(bounds.row).toBeGreaterThanOrEqual(0);
      expect(bounds.row + bounds.height).toBeLessThanOrEqual(rows);
      expect(bounds.col).toBeGreaterThanOrEqual(0);
      expect(bounds.col + bounds.width).toBeLessThanOrEqual(columns);
      if (columns === 100) {
        const screen = tui.captureRenderState().previousLines.map(stripVTControlCharacters);
        expect(screen.join("\n")).toContain(loading ? "cancel" : "close");
        if (rows >= 2) expect(screen.join("\n")).toContain("Codex · Overview");
        if (rows >= 3)
          expect(screen.join("\n")).toContain(loading ? "Fetching usage" : "Report row");
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
