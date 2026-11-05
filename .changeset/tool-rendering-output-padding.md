---
"@eleith-pi/tool-rendering": patch
"@eleith-pi/web-fetch": patch
"@eleith-pi/web-search-codex": patch
---

Honor Pi's `outputPad` setting in shared tool frames using native text padding. Headers, bodies, and footers now align with the configured margins, and wrapping uses the remaining content width. Preserve the 210-column content cap and safely reduce padding in narrow terminals, including the clipping-marker fallback for wide glyphs in one-column content areas.
