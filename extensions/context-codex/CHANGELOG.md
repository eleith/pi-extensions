# @eleith-pi/context-codex

## 0.1.1

### Patch Changes

- 7f9868d: Remove the ineffective before_agent_start preference replay fallback on Pi 1.2+ and document idle-only reconciliation. Custom-triggered turns retain the current window; pending branch preferences replay on normal idle input before compaction.

## 0.1.0

### Minor Changes

- Introduce the renamed Codex-only context control package with verified model profiles for GPT-6 Sol, GPT-6.1 Sol, and GPT-6 Astra. Extend or restore Pi's local compaction window using the catalog baseline, with notices when no extension is needed or the baseline is unknown. Preserve existing branch preferences and use the new context-codex command.
