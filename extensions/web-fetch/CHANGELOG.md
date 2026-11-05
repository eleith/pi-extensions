# @eleith-pi/web-fetch

## 0.1.2

### Patch Changes

- 7465c2d: Import tool schemas directly from Pi's host-provided TypeBox package and declare its peer dependency, keeping the extensions compatible with the Pi 1.5 SDK without relying on pi-ai's former TypeBox re-exports.
- 40de6af: Honor Pi's `outputPad` setting in shared tool frames using native text padding. Headers, bodies, and footers now align with the configured margins, and wrapping uses the remaining content width. Preserve the 210-column content cap and safely reduce padding in narrow terminals, including the clipping-marker fallback for wide glyphs in one-column content areas.

## 0.1.1

### Patch Changes

- a089118: Report invalid JSON with a specific, safe diagnostic and raw-retry guidance while preserving alternate-source recovery.

## 0.1.0

### Minor Changes

- Introduce `web_fetch` and `web_fetch_batch` with browser-fingerprinted requests, Defuddle extraction, markdown/html/json/raw output, temporary downloads, and bounded ordered batches.
- Add externally overridable default framed rendering and shared-prefix on/off/toggle controls with test [URL] through the ordinary agent/tool pipeline.
- Preserve JSON source without reserialization. Delegate site-specific extraction, conversion, and reply filtering to Defuddle.
- Adapt MIT-licensed pi-smart-fetch 0.3.17 with wreq-js 3.2.0, Defuddle 0.19.4, and Linkedom 0.18.13. Preserve upstream attribution.
- Cancellation is best-effort at the native transport boundary; accepted-data limits do not promise immediate native network shutdown or hard native-memory limits.
