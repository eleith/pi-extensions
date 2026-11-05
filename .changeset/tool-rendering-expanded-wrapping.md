---
"@eleith-pi/tool-rendering": patch
"@eleith-pi/web-search-codex": patch
---

Wrap long expanded tool-result lines with Pi's public ANSI-aware wrapping helper, including code, diffs, and errors. Keep compact clipping, logical counts, and execution-level truncation unchanged. Web-search errors now rely on the shared error-frame wrapping rather than pre-wrapping the same text.
