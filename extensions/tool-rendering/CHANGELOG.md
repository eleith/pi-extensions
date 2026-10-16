# @eleith-pi/tool-rendering

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
