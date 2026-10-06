# title status

puts the session name in the terminal title with a small spinning icon when an
llm is working

## why

when running multiple LLMs, it's nice to quickly observe which ones are running

## how to install

```sh
pi install npm:@eleith-pi/title-status
```

## how to use

make an llm call and be amazed.

Use `/eleith:title-status toggle` to be unamazed.

## how to configure

update `~/.pi/agent/extensions/eleith.json` with the following:

```json
{ "commandPrefix": "personal" }
```

and your shorts will now be `/personal:title-status` instead!
