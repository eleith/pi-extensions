---
"@eleith-pi/codex": patch
---

Remove unused Codex auth-scope fingerprinting and the auth-only lookup path. Return catalog JSON directly without unused metadata wrappers, preserving account-request authentication, endpoint restrictions, cancellation, timeouts, response bounds, and safe errors.
