# @eleith/pi-title-status

## 0.1.0

### Minor Changes

- 33d4359: Extract title status as an independent Pi package with a native prefixed command.

### Patch Changes

- 640ca96: Extract context-window with branch preferences, native status/extend/restore commands, and cancellable reduction confirmation. Allow no-argument default actions in the shared command helper.
- 1eeba7d: Share settings and native-command helpers through a private workspace package and bundle them into each extension. Read settings from the agent directory's extensions/eleith.json and separate runtime behavior into controllers.
