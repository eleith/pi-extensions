# Changesets

Packages will be versioned independently. Every extracted package starts at `0.0.0` and adds an initial minor changeset; the first reviewed versioning produces `0.1.0`.

Run `pnpm changeset` for release-relevant package changes, then `pnpm format`. Changesets may generate formatted text internally; oxfmt is the sole repository formatting gate. Documentation and test-only changes do not need a changeset.

`pnpm version:packages` updates versions and changelogs; it does not publish. The private root is neither versioned nor tagged. Publication requires a separately authorized, protected package tag and publishes only its validated package.
