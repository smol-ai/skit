# pnpm-managed Skills

SKIT reports dependency-provided Skills managed by pnpm and leaves them in place. Inventory and setup show the supplying package and version; the audit identifies pnpm as the source. Setup displays these Skills for inspection, with selection disabled. They are excluded from onboarding and removal. Acquisition through their installed paths and retirement of their links are refused.

The structured owner is `pnpm`, with `package`, `version`, and `ledgerPath` evidence. This changes the output contracts to `skit.setup.v6` and `skit.inventory.v10`.

Recognition uses `linkedSkills` in pnpm's `.modules.yaml`, a live symlink to `skills/<directory>`, and the supplying package's `package.json`. The ledger reader accepts JSON and YAML. A name starting with `pnpm-` alone does not establish management. A recorded path replaced by an ordinary directory is not treated as pnpm-owned. Linked local packages also require an installed dependency link corroborating their package directory. An unrelated user-created alias is not attributed to pnpm merely because it points to the same target.

Use pnpm's permissions and dependency configuration to enable, revoke, or remove these Skills. SKIT does not import them or take custody. Parent-directory acquisition checks every selected member before retaining any content, including declared collections; selecting a package root or its `skills/` directory cannot bypass this rule.

Authored workspace sources retain their authored or repository classification even when pnpm links to them. Their recorded pnpm installation aliases are reported separately and left in place. The authored source can still be retained explicitly. Likewise, a separate fixture used by a `file:` dependency retains its ordinary repository classification when it is distinct from the installed package copy.

An unrecorded user alias to installed pnpm content keeps its own owner classification and remains visible for inspection, with acquisition and takeover disabled. The user-created link itself remains removable through setup; pnpm's recorded links and package bytes remain protected.

Malformed or missing ledgers and dangling links cannot establish verified pnpm provenance. Broken links remain visible in diagnostics. This is observed package-manager attribution, not authenticated SKIT custody.
