# Implementation plan: source first, infrastructure incrementally

Bring the existing personal extensions into this repository, following the seven independent packages in [architecture.md](architecture.md). Preserve their READMEs and behavior, then add simple infrastructure that protects actual code or supports an actual release.

Work in small, reviewable changes. **Do not stage or commit without explicit owner approval.** Implementation approval is not commit approval. Never edit the live extensions/settings, install into the personal agent, push, publish, or activate remote CI as part of local extraction.

## Working principles

- Extract directly into final package locations; no committed legacy snapshots or transitional aggregate package.
- Preserve the owner's root and package READMEs. Update paths, commands, and installation instructions as the corresponding code changes, not with speculative documentation.
- Prefer standard pnpm, TypeScript, Vitest, Changesets, and CI commands over custom wrappers.
- Add tests alongside real package behavior. No synthetic extensions, generic host simulator, custom import resolver, Changesets validator, or archive framework up front.
- Introduce reusable test support only when actual package tests need it. A test should explain the behavior or regression it protects.
- Review manifests/imports directly while the repository is small. Use normal pack/install commands for acceptance. Automate repetitive checks only after a concrete need is visible.
- Keep credentials and personal configuration out of version control. Tests and manual trials use disposable agent directories, never the live installation.

## Package contract

Final directories are `packages/{progress,notifications,context-window,compact-editor-chrome,title-status,tool-rendering,welcome}`, named `@eleith/pi-<directory>`.

Each package carries its own ESM manifest, MIT license, existing README, local runtime modules, and `src/index.ts`. Declare `keywords: ["pi-package"]`, `pi.extensions: ["./src/index.ts"]`, an explicit runtime/assets/docs allowlist excluding tests, repository directory metadata, and the Gitea `publishConfig.registry` pin. Welcome keeps its runtime tree data and README SVG; verify attribution before distribution.

The root stays private, unversioned, and without a Pi aggregate manifest. Packages start at `0.0.0`; initial minor changesets produce reviewed `0.1.0` versions later. Imported host packages are wildcard peers, with pinned development copies at root and peer auto-install disabled. No sibling imports/dependencies, shared runtime singleton, root runtime helpers, or bundled host copies.

Each extraction includes its own native prefixed command and config reader, not a later command retrofit. Follow the architecture's action defaults, strict user-file `commandPrefix` contract, post-bind registration/conflict handling, native completions, runtime-only toggles, and branch persistence. Drop the aggregate router, old aliases, and forced-Tab wrapper.

## PR 1 — Minimal workspace setup

Keep the root manifest, pnpm workspace and lockfile, MIT license, existing root README, concise contributor rules, ignores, and ordinary formatter/linter/TypeScript configuration. pnpm is pinned to **11.2.2**; development hosts are Pi **1.0.0**. Ignore `.nono.json`, dependencies, generated output, and local caches. No repository `.npmrc` is needed.

Remove custom bootstrap/check scripts, synthetic fixtures, host-test scaffolding, and verification reports. Do not add empty passing suites or pretend that infrastructure tests cover extensions that have not been extracted.

Formatting applies now. Lint/typechecking become meaningful when package source exists. Add Vitest and a plain `vitest run` command with the first real tests; do not install/configure an unused testing framework just to fill out PR 1. No umbrella check command is required before it has real work to perform.

Keep independent Changesets configuration for package versioning, but use its normal commands and review the resulting entries/manifests/changelogs. No custom Changesets coverage or release-mode parser.

**Review gate:** small understandable workspace diff, preserved documentation, consistent lockfile, ignored personal files, and no commits or remote actions without owner approval. Package behavior, packaging, CI, and release checks are not claims made by this setup-only change.

## PR 2 — Terminal packages

Extract one actual package at a time: title-status, progress, notifications. Preserve each existing README and add its manifest, command/config reader, local controller, and focused tests.

- **Title:** preserve enabled default, 300 ms spinner, idle icon, deferred title updates, and restoration. Test pending-update/shutdown behavior and absence of terminal output outside TUI.
- **Progress:** preserve OSC 9;4/tmux transport, one-second keepalive, and 20-second test. Clear at final `agent_settled`, not `agent_end`; test retries/continuations, test cancellation, toggles, and idempotent cleanup.
- **Notifications:** preserve total-run timing, 15-second threshold, before-settle outcome and final settled delivery. Test representative threshold/outcome cases, missing optional transports, bounded child processes, sanitization, and shutdown cancellation.

Tests target these packages, their commands/defaults, and their config readers. A small real Pi loader/session test should prove the actual package's bound command and completion behavior; do not revive a separate synthetic host-contract suite. Exercise each package alone and the introduced packages together in disposable sessions. Manually inspect terminal behavior inside/outside tmux when the real feature is available.

## PR 3 — Context, editor chrome, welcome

Continue one package at a time with existing documentation and focused behavioral tests.

- **Context:** preserve profiles, active-branch `eleith-context` state, private model-copy ownership/baseline restoration, thinking level, auth handling, reduction confirmation, and pre-prompt reconciliation. Use the configured full command in advice. Protect async changes with generation checks, rollback, and cancellable dialogs; test real state/model transitions, not paid provider calls.
- **Editor chrome:** preserve footer/widget identifiers and layout. Dispose Git polling processes/timers/listeners and discard stale results. Keep the optional plain-data `eleith:ui-status:collect` exchange UI-only, with no required sibling import. Clearing an owned footer restores Pi's default, not another extension's footer.
- **Welcome:** localize the thinking-style helper; preserve `eleith-startup-tree` entries, renderer, sizing, and assets. Render optional fresh chrome/nono text only when available. Test standalone rendering, optional status, old entries, and reload/startup duplication against the real package.

Keep state and lifecycle resources per factory. Use targeted manual resizing/footer checks alongside these extractions.

## PR 4 — Tool rendering

Move existing renderer code into its final package, preserving rendering while delegating execution to host tool definitions. Start with bash/read, then the remaining tools; include command/config and relevant tests with each increment.

Test actual execution parity with identical effective cwd/settings: shell path/prefix, image auto-resize, updates, aborts, errors, truncation, result fields, and filesystem effects. Retain old ls/find rendering-detail readers and document any intentional additive metadata. State and render timers must be factory-local and disposed. Explicitly enable optional grep/find/ls for their tests.

Manual acceptance uses the real extracted tools, terminal status, welcome, and editor together in disposable TUI sessions, including renamed commands and ordinary native completion.

## PR 5 — Infrastructure for real packages and release

Only after package source exists, add the smallest meaningful CI and packaging/release checks.

- Run ordinary formatting, lint, typechecking, and actual tests in Woodpecker. Reuse the owner's workspace, pinned tools, and notification pattern. Validate the Node **22.19.0** / **26.4.0** target matrix before support claims. No credentials in untrusted PR jobs.
- Pack the seven actual packages using standard pnpm commands. Inspect source/assets/licenses/changelogs and load each archive independently outside repository ancestry, then actual package combinations/subsets. Confirm no sibling dependency, undeclared import, or physical host peer. Add a small automation only if manual repetition warrants it; no generic archive framework by default.
- Keep test environments disposable from before host imports. `PI_CODING_AGENT_DIR` must match the test directory; SDK `agentDir` alone does not redirect `getAgentDir()` or host import-time paths. Disable model-network/telemetry activity, use fake providers only when a real package needs agent turns, and emit orderly shutdown before session disposal. Preinstall Git/rg/fd where actual tool tests require them; never silently download them.
- Use Changesets directly for independent versions/changelogs. Review changed-package coverage and initial `0.1.0` output; in a disposable copy verify a single-package patch leaves siblings unchanged. Versioning does not publish.
- Reuse the owner's tag-driven publication pattern: a protected, owner-authorized tag must select one of the seven known packages and match its reviewed manifest version. Publish **only that package** with filtered pnpm publication. Never run workspace-wide `changeset publish`, create tags in CI, expose tokens, or assume a tag filter alone authorizes secrets.
- Consumer scope mapping and publication pins must target the owner's Gitea registry, with auth outside source. Verify access and actual Pi install/update/remove using separately authorized disposable releases before production publication. No npmjs.com fallback and no production overwrite/delete. Pi 1.0.0's configured-pnpm removal needs a verified persistent peer-suppression setting; do not claim support without observation.

Remote CI activation, disposable publication, production tags/releases, and personal cutover remain separate owner decisions. Local packing is not registry-installation proof. Report unobserved infrastructure as unverified rather than building or documenting assumptions as facts.

## Cutover

Only after reviewed package/release proof, the owner backs up personal settings/source externally and moves the old aggregate out of every discovery path before loading desired packages. Never run old and new together. Verify commands, preserved defaults/session state, terminal/tools, optional services, independent update/remove, and rollback in the owner's environment.

The immediate goal is existing extension code in a maintainable repository. Infrastructure is added to serve that code, not as a prerequisite framework.
