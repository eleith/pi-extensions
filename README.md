# my π extensions

a handful of small personal extensions to Pi, only using documented APIs.

| extension                                                | description                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [compact editor chrome](compact-editor-chrome/README.md) | minimal status details around the prompt input. less is more                          |
| [context](extensions/context-window/README.md)           | status and controls for the context window                                            |
| [notifications](extensions/notifications/README.md)      | notifications on turn end using notify-send (with OSC777 fallback for remote support) |
| [progress](extensions/progress/README.md)                | OSC9;4 progress bars (with TMUX wrapping support) while waiting on a turn             |
| [title status](extensions/title-status/README.md)        | simple terminal titles with icon progress indicators                                  |
| [tool rendering](tool-rendering/README.md)               | minimal and pretty rendering for bash/ls/grep/read tool calls                         |
| [welcome](welcome/README.md)                             | grow a tree everytime you start pi                                                    |

## why

because extending π is at the ❤️ of how and why it was built

## develop

extensions live in `extensions/`. shared helpers live in the private `packages/internal/`
workspace package and are bundled into each extension.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```
