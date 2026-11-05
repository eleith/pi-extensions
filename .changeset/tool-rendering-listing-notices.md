---
"@eleith-pi/tool-rendering": patch
---

Separate native ls/find limit and byte-truncation notices from filenames when rendering. Keep actionable notices visible as warnings, exclude them from entry/file and hidden counts, and mark byte-truncated results in the summary. Execution, stored results, and legacy display overrides remain unchanged.
