# context

enable codex gpt-6 context limits to optionally choose between default (272k)
and extended (~1M) tokens

## why

when you want to avoid compaction and you think 1.5x token cost is worth it...

## how to install

```sh
pi install npm:@eleith-pi/context-window
```

## how to use

run `/eleith:context` to see the state of your context

run `/eleith:context extend` to extend the context to it's advertised maximum
(at a higher price point), only if you are currently using a gpt-6 supported
model

run `/eleith:context restore` to restore it back to the default.

## how to configure

update `~/.pi/agent/extensions/eleith.json` with the following:

```json
{ "commandPrefix": "personal" }
```
