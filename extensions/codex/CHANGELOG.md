# @eleith-pi/codex

## 0.2.2

### Patch Changes

- 8281f21: Keep saved fast-mode choices active without expiry across reloads, tree navigation, and model reselection. Check eligibility only when explicitly enabling fast mode, avoiding fast-mode authentication and catalog preparation on prompts while preserving scope checks and requested-versus-reported tier status.
- 0923c70: Show the Codex overview and account usage in a consistent, titled terminal inspector with native borders and keybinding-aware footers. Keep loading, results, and errors in one dismissible overlay without transcript notifications, support scrolling for longer reports, and preserve textual feedback outside the terminal UI.

## 0.2.1

### Patch Changes

- Separate Codex Retry-After parsing from HTTP error classification and strengthen rate-limit regression coverage. Correct Codex names, links, installation and command instructions in the READMEs.

## 0.2.0

### Minor Changes

- 2e10c83: Rename context-codex to codex while preserving context controls and branch state. Add Codex account usage reporting and explicit branch-local, per-model fast controls using Pi's existing login, conservative catalog eligibility, and higher-consumption confirmation for priority requests on supported direct legacy Codex selections.

### Patch Changes

- 4b19b7d: Make Codex controls easier to use with matching context and fast on/off/toggle commands, a shared local dashboard, descriptive subcommand completion, clearer allowance reports, and a native cancellable loader for account usage requests.

## 0.1.1

### Patch Changes

- 7f9868d: Remove the ineffective before_agent_start preference replay fallback on Pi 1.2+ and document idle-only reconciliation. Custom-triggered turns retain the current window; pending branch preferences replay on normal idle input before compaction.

## 0.1.0

### Minor Changes

- Introduce the renamed Codex-only context control package with verified model profiles for GPT-6 Sol, GPT-6.1 Sol, and GPT-6 Astra. Extend or restore Pi's local compaction window using the catalog baseline, with notices when no extension is needed or the baseline is unknown. Preserve existing branch preferences and use the new context-codex command.
