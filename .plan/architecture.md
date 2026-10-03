# Personal Pi extensions: architecture

## Recommendation

Keep one Gitea source monorepo and distribute **seven independent `@eleith/pi-*` packages** through the owner's Gitea npm-compatible registry, not npmjs.com. Each package registers its own native, consistently prefixed Pi command. Delete the proposed eighth shortcuts/router package entirely; do not replace it with command discovery events, a helper package, a shared menu, or a Tab interception wrapper.

This is the owner's approved simplest direction. Installing all seven intentionally adds seven slash-menu entries; installing a subset adds only that subset's commands. The trade-off is more top-level entries and a tiny duplicated config reader, in exchange for commands that work without another package. Preserve existing action defaults, runtime toggles, and context persistence; this is not a settings redesign.

Use pnpm, independent Changesets versions, MIT, Woodpecker, oxlint, oxfmt, and Vitest as needed. Get the existing extensions into the repository first, then layer on simple infrastructure for concrete package behavior and release needs. Do not build speculative validators, synthetic host suites, or a bootstrap framework before real packages exist. Preserve the owner's existing READMEs and evolve them with the code. Execution is described in [implementation.md](implementation.md). Approval of implementation does not authorize staging, commits, live configuration edits, push, publication, or personal cutover.

## How it works

### Packages and native commands

Each `packages/<name>` directory has its own manifest, TypeScript entry point, README, license, and release history. Pi loads only installed packages; each owns its state, timers, processes, handlers, and cleanup. There are no sibling imports/dependencies, shared runtime singleton, root Pi aggregate manifest, or runtime helper package.

| Package                            | Native command example               |
| ---------------------------------- | ------------------------------------ |
| `@eleith/pi-progress`              | `/eleith:progress toggle`            |
| `@eleith/pi-notifications`         | `/eleith:notifications off`          |
| `@eleith/pi-context-window`        | `/eleith:context extend`             |
| `@eleith/pi-compact-editor-chrome` | `/eleith:compact-editor-chrome show` |
| `@eleith/pi-title-status`          | `/eleith:title-status hide`          |
| `@eleith/pi-tool-rendering`        | `/eleith:tool-rendering toggle`      |
| `@eleith/pi-welcome`               | `/eleith:welcome small`              |

On loading, each package independently reads the same user file and builds its command name and usage text. At `session_start`, after Pi binds the runtime API, it checks for a known command conflict and registers once with native `registerCommand`. Pi invokes that package's handler with the current command context; the handler validates its arguments and calls its own controller. Native `getArgumentCompletions` supplies action suggestions. Ordinary host completion is sufficient for this first pass: migrate only reusable pure completion logic, not the old forced-Tab wrapper or its aggregate parser.

Notifications/progress retain `on|off|test|toggle`, defaulting to toggle. Editor/title/tool chrome retain `show|hide|toggle`, also defaulting to toggle. Context retains no-argument status and `extend|restore`. Welcome retains `show|auto|large|small|tiny`, with no argument, show, and auto using automatic sizing. Remove the bare `/context-window` and aggregate `/eleith` commands outright, with no aliases.

### One user setting, unchanged behavior

The stable filename is `<getAgentDir()>/eleith-extensions.json`, normally `~/.pi/agent/eleith-extensions.json`. Its sole optional key is `commandPrefix`:

```json
{ "commandPrefix": "personal" }
```

Missing file or missing key means `eleith`. A prefix is a lowercase bare segment matching `^[a-z][a-z0-9-]*$`; it cannot contain a slash, colon, whitespace, or be empty. Malformed JSON, a non-object value, unknown keys, an invalid prefix, or a read error other than a missing file causes a package load error naming the path. Do not silently register under an unexpected default. Readers never write the file and never search the project for overrides.

Changing the prefix to `personal` renames every installed command to `/personal:<area>` on reload/restart, including its usage, errors, and examples. It does not rename the file or package. There is no `schemaVersion`, saved toggle, or new per-extension setting. Existing enabled defaults return with a fresh runtime; context preferences still reconstruct `eleith-context` entries from the active branch, and welcome still reads/renders `eleith-startup-tree` entries.

A known resource-command conflict leaves that package's command unregistered with a clear diagnostic, without disabling its unrelated behavior. Conflict checks run only after binding: factory-time `getCommands()` is unavailable. Pi can suffix colliding extension names and has no public command-unregister API; suffixes are not supported aliases. A later third-party dynamic collision requires removal/rename and reload, not a router that claims to prevent it.

### Optional welcome display

Welcome localizes the tiny thinking-style helper instead of importing chrome. Keep its optional chrome/nono status display through a tiny UI-only plain-data event: chrome can return a current status snapshot when welcome renders; absent chrome/status data means the optional text is omitted. This carries no command definitions, completers, action handlers, or invocation messages. Neither package requires the other or nono, and command prefix changes do not affect this display exchange. Each package releases its own listeners on shutdown.

### Registry and releases

Source stays at `git@git.eleith.com:eleith/pi-extensions.git`. Versioned archives live in the owner's Gitea registry; users install independently with `pi install npm:@eleith/pi-progress`. The user's `~/.npmrc` needs this scope mapping in the configuration seen by Pi's actual npm command:

```ini
@eleith:registry=https://git.eleith.com/api/packages/eleith/npm/
```

The owner supplied an existing Woodpecker publishing example using this Gitea endpoint shape and the `npm_owner`/`npm_token` secrets. Reuse that pattern; this repository's registry owner, permissions, and end-to-end installation still need verification. Authentication stays outside version control. Per-package `publishConfig.registry` pins publication but does not configure consumer lookup. There is no npmjs.com fallback for these packages. Root is private; packages are publishable, which does not determine Gitea visibility.

Changesets versions the seven packages independently, starting deterministically at `0.1.0` from `0.0.0` plus initial minor changesets. A reviewed version/changelog commit does not publish. Follow the owner's existing tag-driven workflow: an authorized source tag such as `@eleith/pi-progress@0.1.0` triggers checks, tag-to-manifest version validation, and publication of **only that package** using `pnpm --filter <validated-package-name> publish --no-git-checks`. Do not run workspace-wide `changeset publish` in a package-tag job. Verify a staging/disposable release first; never overwrite/delete production releases. Exact-version Pi sources stay pinned during updates; advancing/removing one package must not alter siblings.

Use the supplied workspace layout (`base: /workspace`, `path: src`), shared `COREPACK_HOME`, pnpm 11.2.2 as the bootstrap target subject to compatibility checks, and the existing email notification pattern. Pin Corepack rather than installing `@latest`. Push/main and pull-request runs perform checks without publishing; only protected, owner-authorized matching package tags may receive publication secrets. A tag filter alone is not authorization.

## Decisions — approved

- **Distribution:** one source monorepo, seven separate Gitea registry packages; no eighth router, Git collection install, or separate release repository.
- **Controls:** native per-package prefixed commands and argument completion; no command collection/discovery/invocation protocol, shared menu/subcommand API, or completion-provider replacement.
- **Configuration:** only the shared user-file `commandPrefix`; independent readers, stable filename, reload/restart rename, explicit errors, and unchanged defaults/persistence. No old aliases.
- **Optional UI:** preserve welcome status text without a mandatory sibling; any tiny status-data event is UI-only and independent of commands.
- **Tooling:** pnpm, Changesets, MIT, Woodpecker, oxlint, oxfmt, Vitest; ignore `.nono.json` and extract directly into final locations without transitional source snapshots. Reuse the supplied tag-driven per-package publication and email notification pattern; Changesets manages versions/changelogs, not workspace-wide publication.

## What could change execution

Colon names are supported by the inspected loader/parser, not yet proved by runtime tests here. The smallest check is a real Pi loader/session test exercising registration after binding, invocation, completion, conflicts, rename/reload, subsets, and reversed load order. If a tested host release behaves differently, stop that support claim and resolve the host contract rather than reinstating routing or custom Tab parsing.

Host imports remain `peerDependencies: "*"`, with pinned development hosts and no bundled host copies. Disable pnpm peer auto-install before generating the lockfile. Verify frozen installs, isolated archives, and real Pi install/update/remove with default npm and configured pnpm. Pi 1.0.0's pnpm removal lacks the install suppression flag, so configured-pnpm support requires a verified persistent user config or `npmCommand` setting covering removal too.

Registry access/visibility, publish options, protected Woodpecker triggers/credentials, and clean-container tool versions still need observation. An owner-authorized staging/disposable publish followed by actual Pi retrieval/install/update/remove is the minimum remote proof. Failure gates release, not local extraction; no distribution change is implied. Keep offline Git/rg/fd prerequisites and configured shell/image tool-execution parity in the tests.

**No architecture decisions remain open.** Follow the five-PR plan when implementation is separately authorized. Infrastructure proof and the owner's actual release/cutover authority remain gates. Cutover backs up settings/source externally and moves the old aggregate out of discovery before loading new packages; never run both together.

## Evidence and limits

- Reference: `~/.pi/agent/extensions/eleith/index.ts` defines current actions/defaults; `context/index.ts` registers the bare command; `welcome/index.ts` imports chrome and uses its status callback; `command-completion/index.ts` contains the wrapper being dropped.
- Installed Pi **1.0.0**: `docs/extensions.md`, `packages.md`, `sdk.md`, and `slash-commands.md` were read fully. `dist/core/extensions/types.d.ts` defines native completions. `loader.js` requires a nonempty command name; `agent-session.js` splits at the first space, binds APIs before `session_start`, and exposes resource commands; `runner.js` suffixes duplicates. `dist/config.js` exports the agent-directory lookup. Interactive mode rebuilds completion after binding. These inspections are not runtime-test results.
- The owner's supplied `@luzzle/core` Woodpecker example establishes the publishing convention: pnpm 11.2.2, package-specific tag/version checks, Gitea registry authentication through existing secrets, filtered package publication, and success/failure emails. It has not been executed for this repository.
- `dist/core/package-manager.js` establishes configured npm commands, install-time host-peer suppression, and the pnpm removal caveat. [Gitea npm registry](https://docs.gitea.com/usage/packages/npm/) documents registry/auth configuration and immutable name/version conflicts; [Changesets configuration](https://changesets.dev/guide/config) and [CLI](https://changesets.dev/guide/cli) describe independent versioning/publication. None proves the owner's infrastructure is available. This revision ran no runtime tests, installs, CI, pushes, or publications.
