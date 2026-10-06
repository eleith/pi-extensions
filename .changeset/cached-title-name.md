---
"@eleith-pi/title-status": patch
---

Cache the sanitized session name between session/name changes so spinner ticks do not repeatedly scan session history, including for unnamed sessions.
