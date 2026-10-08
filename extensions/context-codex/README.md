# context codex

extend or restore Pi's local compaction window for supported `openai-codex` models.
verified profiles currently cover GPT-6 Sol, GPT-6.1 Sol, and GPT-6 Astra;
unknown models are not guessed.

## why

keep more context before compaction when you need it. this changes Pi's local
compaction window, not server capacity or account limits. larger context may cost more.

## install

```sh
pi install npm:@eleith-pi/context-codex
```

## use

- `/eleith:context-codex` shows context, compaction, and cache status.
- `/eleith:context-codex extend` selects the verified local window when larger.
- `/eleith:context-codex restore` returns to the catalog baseline, confirming reductions.

branch preferences persist across reloads. the catalog baseline is not guessed:
missing baselines are reported, and models already at or above the verified window
get a no-extension notice rather than a smaller window.

### migrate

run `/eleith:context restore` with the old extension loaded before removing it:

```sh
pi remove npm:@eleith-pi/context-window
pi install npm:@eleith-pi/context-codex
```

branch preferences are preserved. do not load both packages together.

## config

set a command prefix in `~/.pi/agent/extensions/eleith.json`:

```json
{ "commandPrefix": "personal" }
```

then use `/personal:context-codex`.
