# Oxlint policy

- `boundaries.mjs`: private modules and names, permitted callers, service IDs.
- `layout.mjs`: allowed source locations and paths whose placement is undecided.
- `exports.mjs`: core package subpaths and their source files.

The rules live in `lint/oxlint-plugin-skit.mjs`, `lint/library-rules.mjs` and
`lint/frontend-rules.mjs`. `.oxlintrc.json` selects which rules run on each path.
`scripts/check-structure.mjs` checks the export map against core's `package.json`.

Run `pnpm lint:code` for Oxlint and `pnpm lint:structure` for export consistency.
Durable design rationale lives in [ADRs](../docs/adr/).
