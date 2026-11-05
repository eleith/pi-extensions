# @eleith-pi/web-search-codex

## 0.1.3

### Patch Changes

- 7465c2d: Import tool schemas directly from Pi's host-provided TypeBox package and declare its peer dependency, keeping the extensions compatible with the Pi 1.5 SDK without relying on pi-ai's former TypeBox re-exports.
- bcdcf31: Wrap long expanded tool-result lines with Pi's public ANSI-aware wrapping helper, including code, diffs, and errors. Keep compact clipping, logical counts, and execution-level truncation unchanged. Web-search errors now rely on the shared error-frame wrapping rather than pre-wrapping the same text.
- 40de6af: Honor Pi's `outputPad` setting in shared tool frames using native text padding. Headers, bodies, and footers now align with the configured margins, and wrapping uses the remaining content width. Preserve the 210-column content cap and safely reduce padding in narrow terminals, including the clipping-marker fallback for wide glyphs in one-column content areas.

## 0.1.2

### Patch Changes

- Restore wildcard ranges for host-provided Pi peer dependencies, following Pi's packaging guidance. Keep the minimum Pi requirement documented rather than constraining the host's dependencies.

## 0.1.1

### Patch Changes

- Declare Pi 1.1.0 as the minimum compatible peer version, matching the extension's documented requirements.

## 0.1.0

### Minor Changes

- Add a Codex-only native web search tool with citation sources, bounded output, shared frames, activation controls, and an explicit live test. Requires Pi 1.1.0 or newer.
