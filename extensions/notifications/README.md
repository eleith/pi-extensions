# notifications

after a 15 second LLM run (or a failed call), this sends a desktop notification

## why

so i can regain focus if i switched away from my terminal.

attempts to use `notify-send` with a fallback to OSC 777.

## how to use

send in a prompt and watch the magic,
or force it with `/eleith:notifications test`

use `/eleith:notifications off` to stop the magic

## how to configure

update `~/.pi/agent/extensions/eleith.json` with the following:

```json
{ "commandPrefix": "personal" }
```
