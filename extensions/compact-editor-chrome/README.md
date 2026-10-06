# compact editor chrome

this puts the model, thinking level, and context usage just above the editor
and puts the project folder, git branch, and git file changes below it.

## why

less is more. i wanted to claw back as many lines as i could. i would have done
more, but because i use an `nvim` extension, i couldn't embed the status into
the prompt bar itself.

## how to install

```sh
pi install npm:@eleith-pi/compact-editor-chrome
```

## how to use

look at it!

use `/eleith:compact-editor-chrome toggle` if you no longer want to look at it

hiding the chrome restores Pi's default footer.

## how to configure

update `~/.pi/agent/extensions/eleith.json` with the following:

```json
{ "commandPrefix": "personal" }
```
