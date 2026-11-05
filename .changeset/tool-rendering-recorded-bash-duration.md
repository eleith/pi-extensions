---
"@eleith-pi/tool-rendering": patch
---

Use Pi's recorded execution duration for completed and restored bash rows, retaining live elapsed updates and the observed-time fallback when duration metadata is unavailable. Do not fabricate zero durations for final-only rows that were never observed running.
