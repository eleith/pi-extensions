# tool rendering

this gives Pi's built-in `bash`, `read`, `grep`, `ls`, `find`, `write`, and `edit` tools consistent, pretty and minimal rendering in the terminal.

## why

because

## how to install

```sh
pi install npm:@eleith-pi/tool-rendering
```

## how to use

make a tool call and be impressed.

use `/eleith:tool-rendering toggle` to be unimpressed.

requires Pi 1.0.4 or newer.

`show` and `hide` immediately change the preference for future tool rows, even during a run.
existing rows keep their style; reconstructed history uses the current preference.
hiding delegates to Pi's existing renderer chain, including other extensions.

only rendering is registered: configured tools, execution, active tools, schemas,
and model-facing results remain unchanged. old sessions' display details still work.
frames target these seven tool names; custom tools with the same names may have
output formats that do not match the summaries. hide the frames to use their own rendering.

the working label counts model time, not time spent running tools.

## how to configure

update `~/.pi/agent/extensions/eleith.json` with the following:

```json
{ "commandPrefix": "personal" }
```
