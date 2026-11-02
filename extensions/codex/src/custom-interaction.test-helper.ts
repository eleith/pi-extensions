import { vi } from "vitest";
import type {
  BorderedLoader,
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";

type Tui = ConstructorParameters<typeof BorderedLoader>[0];
type UIComponent = Awaited<ReturnType<Parameters<ExtensionUIContext["custom"]>[0]>>;
type CustomFactory<T> = (
  tui: Tui,
  theme: Theme,
  kb: KeybindingsManager,
  done: (result: T) => void,
) => UIComponent | Promise<UIComponent>;

// The public custom-interaction lifecycle, without starting a terminal. Model Pi 1.3's
// shared editor restoration (not 1.4's dialog stack), so unsafe non-overlay closes
// really can steal focus from a newer interaction. Overlay removal owns only its entry.
export function customInteractionUI() {
  const mainEditor: UIComponent = { render: () => ["editor"], invalidate() {} };
  let editorComponent = mainEditor;
  let focusedComponent = mainEditor;
  const overlays: { component: UIComponent; preFocus: UIComponent }[] = [];
  const requestRender = vi.fn();
  const modals: {
    component?: UIComponent;
    lines: string[];
    closed: boolean;
    adopted: boolean;
    close: ReturnType<typeof vi.fn<(result?: unknown) => void>>;
    requestRender: ReturnType<typeof vi.fn<() => void>>;
  }[] = [];

  const restoreEditor = () => {
    editorComponent = mainEditor;
    focusedComponent = mainEditor;
    requestRender();
  };
  const removeOwnedOverlay = (overlay: (typeof overlays)[number] | undefined) => {
    if (!overlay) return;
    const index = overlays.indexOf(overlay);
    if (index === -1) return;
    for (const entry of overlays) {
      if (entry.preFocus === overlay.component) entry.preFocus = overlay.preFocus;
    }
    overlays.splice(index, 1);
    if (focusedComponent === overlay.component) {
      focusedComponent = overlays.at(-1)?.component ?? overlay.preFocus;
    }
    requestRender();
  };
  const custom = vi.fn<ExtensionUIContext["custom"]>(
    <T>(factory: CustomFactory<T>, options?: Parameters<ExtensionUIContext["custom"]>[1]) =>
      new Promise<T>((resolve, reject) => {
        let overlay: (typeof overlays)[number] | undefined;
        const modal = {
          component: undefined as UIComponent | undefined,
          lines: [] as string[],
          closed: false,
          adopted: false,
          close: vi.fn(),
          // Attribute animation requests to the factory while sharing the same UI surface.
          requestRender: vi.fn(() => requestRender()),
        };
        modal.close.mockImplementation((result: T) => {
          if (modal.closed) return;
          modal.closed = true;
          if (options?.overlay) removeOwnedOverlay(overlay);
          else restoreEditor();
          resolve(result);
          if (modal.adopted) modal.component?.dispose?.();
        });
        modals.push(modal);
        Promise.resolve(
          factory(
            { requestRender: modal.requestRender } as unknown as Tui,
            { fg: (_color: string, text: string) => text } as Theme,
            {} as KeybindingsManager,
            modal.close,
          ),
        )
          .then((component) => {
            // Keep the result observable even on early done, but never adopt or dispose it:
            // native Pi leaves early-done cleanup to the factory's owner.
            modal.component = component;
            if (modal.closed) return;
            modal.adopted = true;
            if (options?.overlay) {
              overlay = { component, preFocus: focusedComponent };
              overlays.push(overlay);
            } else {
              editorComponent = component;
            }
            focusedComponent = component;
            modal.lines = component.render(80);
            requestRender();
          })
          .catch((error: unknown) => {
            if (modal.closed) return;
            if (!options?.overlay) restoreEditor();
            reject(error);
          });
      }),
  );

  return {
    // Vitest erases the generic call signature; the implementation preserves it.
    custom: custom as ExtensionUIContext["custom"] & typeof custom,
    modals,
    requestRender,
    mainEditor,
    get editorComponent() {
      return editorComponent;
    },
    get focusedComponent() {
      return focusedComponent;
    },
    get components() {
      return [editorComponent, ...overlays.map((entry) => entry.component)];
    },
    dispose() {
      for (const modal of modals) modal.component?.dispose?.();
    },
  };
}
