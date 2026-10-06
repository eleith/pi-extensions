# @eleith-pi/title-status

## 0.1.3

### Patch Changes

- a1d18f1: Cache the sanitized session name between session/name changes so spinner ticks do not repeatedly scan session history, including for unnamed sessions.

## 0.1.2

### Patch Changes

- Document installation from npm.

## 0.1.1

### Patch Changes

- Enable automated npm releases through GitHub trusted publishing.

## 0.1.0

### Minor Changes

- 33d4359: Extract title status as an independent Pi package with a native prefixed command.

### Patch Changes

- 640ca96: Extract context-window with branch preferences, native status/extend/restore commands, and cancellable reduction confirmation. Allow no-argument default actions in the shared command helper.
- 1eeba7d: Share settings and native-command helpers through a private workspace package and bundle them into each extension. Read settings from the agent directory's extensions/eleith.json and separate runtime behavior into controllers.
