# codex

context controls, account usage, and fast-mode requests using Pi's existing Codex login.
verified extended-context profiles currently cover GPT-6 Sol, GPT-6.1 Sol, and GPT-6 Astra;
unknown models are not guessed.

## why

keep more context before compaction when you need it. this changes Pi's local
compaction window, not server capacity or account limits. larger context may cost more.

## install

```sh
pi install npm:@eleith-pi/codex
```

## use

- `/eleith:codex` shows the local context and fast-mode dashboard, including compaction and cache status.
- `/eleith:codex context on` selects the verified local window when larger.
- `/eleith:codex context off` returns to the catalog baseline, confirming reductions.
- `/eleith:codex context toggle` switches the saved context preference.
- `/eleith:codex fast on` requests priority processing after confirmation of higher allowance use.
- `/eleith:codex fast off` requests standard processing.
- `/eleith:codex fast toggle` switches the saved fast preference.
- `/eleith:codex usage` fetches account allowance and reset information. in the terminal, the cancel key (Escape by default) aborts the request.

bare `context` and `fast` show the same dashboard as the root command, without account or catalog requests.
fast controls require a direct official legacy `openai-codex` selection with Pi OAuth and no provider override.
enabling priority also requires catalog eligibility.
priority is a request, not a scheduling guarantee; reported response tiers are shown separately.

context and fast preferences persist per model on the active branch across reloads. the catalog baseline is not guessed:
missing baselines are reported, and models already at or above the verified window
get a no-extension notice rather than a smaller window.

local context preference replay only runs while Pi is idle. after tree navigation it waits for
normal user input, before Pi checks compaction. custom-message-triggered turns use
the current window without replaying pending preferences; explicit context and fast
changes also require idle.

### migrate

when migrating from `@eleith-pi/context-codex`, run its old `/eleith:context-codex restore`
command with that extension loaded before removing it:

```sh
pi remove npm:@eleith-pi/context-codex
pi install npm:@eleith-pi/codex
```

if migrating from the older `@eleith-pi/context-window` instead, first use its
`/eleith:context restore` command, then remove that package before installing codex.

branch preferences are preserved. do not load the predecessor and codex together.

## config

set a command prefix in `~/.pi/agent/extensions/eleith.json`:

```json
{ "commandPrefix": "personal" }
```

then use `/personal:codex`.
