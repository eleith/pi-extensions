# web search codex

adds `web_search_codex` for answers and sources through your current Codex model.

## why

one tool. one provider.

## how to install

requires Pi 1.1.0 or newer.

```sh
pi install npm:@eleith-pi/web-search-codex
```

for local development, build and load `extensions/web-search-codex/dist/index.js` with `pi -e`.

## how to use

select an `openai-codex` model and ask it to search.

use `/eleith:web-search-codex toggle` to turn it off.

`/eleith:web-search-codex test` runs a live search test (uses model tokens).

## how to configure

update `~/.pi/agent/extensions/eleith.json` with the following:

```json
{ "commandPrefix": "personal" }
```
