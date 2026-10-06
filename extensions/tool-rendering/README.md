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

`show` and `hide` enable or disable the frames; hiding uses Pi's built-in rendering.

the working label counts model time, not time spent running tools.

## how to configure

update `~/.pi/agent/extensions/eleith.json` with the following:

```json
{ "commandPrefix": "personal" }
```
