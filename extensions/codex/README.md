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
- `/eleith:codex fast on` checks catalog eligibility and requests priority processing after confirmation of higher allowance use.
- `/eleith:codex fast off` requests standard processing.
- `/eleith:codex fast toggle` switches the saved fast preference.
- `/eleith:codex usage` fetches account allowance and reset information. in the terminal, the cancel key (Escape by default) aborts the request.

## config

set a command prefix in `~/.pi/agent/extensions/eleith.json`:

```json
{ "commandPrefix": "personal" }
```

then use `/personal:codex`.
