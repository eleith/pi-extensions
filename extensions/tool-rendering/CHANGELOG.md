# @eleith-pi/tool-rendering

## 0.1.6

### Patch Changes

- 0699dc9: Strip terminal escape sequences and non-printing controls from tool-result bodies, edit diffs, legacy listing details, and write-content previews before applying theme styling. Keep stored and model-facing tool data unchanged.
- bcdcf31: Wrap long expanded tool-result lines with Pi's public ANSI-aware wrapping helper, including code, diffs, and errors. Keep compact clipping, logical counts, and execution-level truncation unchanged. Web-search errors now rely on the shared error-frame wrapping rather than pre-wrapping the same text.
- 1a0c704: Separate native ls/find limit and byte-truncation notices from filenames when rendering. Keep actionable notices visible as warnings, exclude them from entry/file and hidden counts, and mark byte-truncated results in the summary. Execution, stored results, and legacy display overrides remain unchanged.
- 40de6af: Honor Pi's `outputPad` setting in shared tool frames using native text padding. Headers, bodies, and footers now align with the configured margins, and wrapping uses the remaining content width. Preserve the 210-column content cap and safely reduce padding in narrow terminals, including the clipping-marker fallback for wide glyphs in one-column content areas.
- d189083: Use Pi's recorded execution duration for completed and restored bash rows, retaining live elapsed updates and the observed-time fallback when duration metadata is unavailable. Do not fabricate zero durations for final-only rows that were never observed running.

## 0.1.5

### Patch Changes

- 8cee611: Normalize numeric-string read offsets and limits in custom rendering, and omit malformed range hints without corrupting line numbers.

## 0.1.4

### Patch Changes

- Share the existing frame helpers with the new Codex web search extension without changing built-in tool rendering.

## 0.1.3

### Patch Changes

- Use Pi's renderer API without replacing configured tools or modifying execution results. Preserve downstream renderer delegation, legacy display details, and compact frames; apply visibility changes to future rows. Requires Pi 1.0.4 or newer.

## 0.1.2

### Patch Changes

- 5d8d277: Cache unchanged tool frames and preserve Pi's text-layout cache on transcript redraws, while rebuilding on resize, content/state updates, and theme changes.

## 0.1.1

### Patch Changes

- Document installation from npm.

## 0.1.0

### Minor Changes

- 5b0d571: Extract standalone built-in tool rendering with native chrome controls, responsive frames, and scoped working and bash timers.
