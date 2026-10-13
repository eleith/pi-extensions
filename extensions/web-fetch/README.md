# web fetch

adds `web_fetch` and `web_fetch_batch` for readable web pages and temporary downloads.

## why

good fetching. less baggage.

based on [pi-smart-fetch](https://github.com/Thinkscape/agent-smart-fetch/tree/b01116124971de44f16a4477e34c06ba2ab1d0bf). original MIT notices are preserved in LICENSE.

## how to install

requires Pi 1.1.0 or newer and Node 22.19 or newer.

```sh
pi install npm:@eleith-pi/web-fetch
```

for local development, build and load `extensions/web-fetch/dist/index.js` with `pi -e`.

disable pi-smart-fetch first; both register `web_fetch`.

## how to use

ask it to fetch a URL. or several.

markdown is the default. html, json, and raw are available too.
if extraction fails, ask it to retry with raw.

use `/eleith:web-fetch toggle` to turn both tools off. `on` and `off` work too.

`/eleith:web-fetch test [URL]` runs a live fetch test (uses model tokens). defaults to `https://pi.dev/`.

## how to configure

update `~/.pi/agent/extensions/eleith.json` with the following:

```json
{ "commandPrefix": "personal" }
```
