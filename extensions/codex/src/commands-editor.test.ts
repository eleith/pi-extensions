import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CombinedAutocompleteProvider,
  Editor,
  type EditorTheme,
  type Terminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { completeCodexArguments } from "./commands.ts";

const identity = (text: string) => text;
const theme: EditorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

let emptyFileDirectory: string;

beforeEach(() => {
  // File completion must see a real, empty directory, not the user's cwd/home.
  const cache = fileURLToPath(new URL("../../../.cache/", import.meta.url));
  mkdirSync(cache, { recursive: true });
  emptyFileDirectory = mkdtempSync(join(cache, "codex-editor-empty-"));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(emptyFileDirectory, { recursive: true, force: true });
});

it("reopens fast controls on a typed argument prefix and replaces the whole argument", async () => {
  const { editor, getArgumentCompletions, getSuggestions } = createEditor();
  await acceptCodexCommand(editor);

  typeText(editor, "fast");
  await vi.waitFor(
    () => {
      expect(getArgumentCompletions).toHaveBeenLastCalledWith("fast");
      expect(editor.isShowingAutocomplete()).toBe(true);
    },
    { timeout: 1_000 },
  );
  editor.handleInput("\t");
  expect(editor.getText()).toBe("/eleith:codex fast");
  expect(editor.isShowingAutocomplete()).toBe(false);

  const lookupsBeforeSpace = getSuggestions.mock.calls.length;
  editor.handleInput(" ");
  await vi.advanceTimersByTimeAsync(200);
  expect(editor.getText()).toBe("/eleith:codex fast ");
  expect(editor.isShowingAutocomplete()).toBe(false);
  expect(getSuggestions).toHaveBeenCalledTimes(lookupsBeforeSpace);

  editor.handleInput("o");
  await vi.waitFor(
    () => {
      expect(getArgumentCompletions).toHaveBeenLastCalledWith("fast o");
      expect(editor.isShowingAutocomplete()).toBe(true);
    },
    { timeout: 1_000 },
  );

  // Editor exposes menu visibility, not its items. Observe the real provider's
  // public result and the rendered list instead of inspecting editor internals.
  const lookup = getSuggestions.mock.results.at(-1);
  if (lookup?.type !== "return") throw new Error("Native suggestion lookup did not return");
  const suggestions = await lookup.value;
  expect(suggestions?.prefix).toBe("fast o");
  expect(suggestions?.items.map(({ value, label }) => ({ value, label }))).toEqual([
    { value: "fast on", label: "on" },
    { value: "fast off", label: "off" },
  ]);
  const rendered = editor.render(120).join("\n");
  expect(rendered).toContain("Request priority processing");
  expect(rendered).toContain("Request standard processing");

  editor.handleInput("\t");
  expect(editor.getText()).toBe("/eleith:codex fast on");
  expect(editor.isShowingAutocomplete()).toBe(false);
});

it("routes empty-prefix Tab through the native file gate, not Codex arguments", async () => {
  const { editor, getArgumentCompletions, getSuggestions, fileCompletionGate } = createEditor();
  await acceptCodexCommand(editor);
  expect(getArgumentCompletions).not.toHaveBeenCalled();
  getSuggestions.mockClear();
  fileCompletionGate.mockClear();

  // Tab takes the forced-file path. Its native gate rejects this empty argument
  // before a file lookup or the command's argument completer can run.
  editor.handleInput("\t");
  expect(fileCompletionGate).toHaveBeenCalledExactlyOnceWith(
    ["/eleith:codex "],
    0,
    "/eleith:codex ".length,
  );
  expect(fileCompletionGate).toHaveReturnedWith(false);
  expect(getSuggestions).not.toHaveBeenCalled();
  expect(getArgumentCompletions).not.toHaveBeenCalled();
  expect(editor.isShowingAutocomplete()).toBe(false);
  expect(editor.getText()).toBe("/eleith:codex ");
});

function createEditor() {
  // Real TUI without terminal lifecycle, stdin, output, or scheduled rendering.
  const terminal: Terminal = {
    columns: 120,
    rows: 40,
    kittyProtocolActive: false,
    start: () => {
      throw new Error("This UI-only test must not start a terminal");
    },
    stop: vi.fn(),
    drainInput: async () => {},
    write: vi.fn(),
    moveBy: vi.fn(),
    hideCursor: vi.fn(),
    showCursor: vi.fn(),
    clearLine: vi.fn(),
    clearFromCursor: vi.fn(),
    clearScreen: vi.fn(),
    setTitle: vi.fn(),
    setProgress: vi.fn(),
    setProgramStatus: vi.fn(),
  };
  const tui = new TuiMainScreen(terminal);
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  const getArgumentCompletions = vi.fn(completeCodexArguments);
  const provider = new CombinedAutocompleteProvider(
    [{ name: "eleith:codex", getArgumentCompletions }],
    emptyFileDirectory,
  );
  // Call-through spy: suggestion routing and replacement remain native Pi logic.
  const getSuggestions = vi.spyOn(provider, "getSuggestions");
  const fileCompletionGate = vi.spyOn(provider, "shouldTriggerFileCompletion");
  const editor = new Editor(tui, theme);
  editor.setAutocompleteProvider(provider);
  return { editor, getArgumentCompletions, getSuggestions, fileCompletionGate };
}

function typeText(editor: Editor, text: string) {
  for (const character of text) editor.handleInput(character);
}

async function acceptCodexCommand(editor: Editor) {
  typeText(editor, "/eleith:cod");
  await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true), {
    timeout: 1_000,
  });
  editor.handleInput("\t");
  // Native command-name completion already appends a space and closes the menu.
  expect(editor.getText()).toBe("/eleith:codex ");
  expect(editor.isShowingAutocomplete()).toBe(false);
}
