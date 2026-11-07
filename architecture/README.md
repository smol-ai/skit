# Architecture

SKIT keeps state, rules, writes and recovery with the module that owns them.
Commands collect input, call owners and render results.

## Ownership

[`app.ts`](app.ts) maps owners to modules and state. Read the owning module for its
API; the map does not prove implementation or runtime behavior.

- Library owns imported collections, enabled choices and Library recovery.
- InstalledSkills owns installed folders and their ownership markers.
- MachineSettings owns device settings.
- AuthorWorkspace owns workspace identity, connection metadata and sync writes.
- AuthorHistory owns saved trees, revisions and sync checkpoints.
- Registry code handles remote access and credentials.
- Server owners control their respective records and blobs.

## Rules

- Call owners rather than opening their stores or writers.
- Keep storage formats, locking and recovery private to the owner.
- Collect interactive choices outside writer scopes.
- Retain the inputs and revision behind a reviewed change; revalidate on apply.
- Record recovery information before the effects that need it.
- Recover using the recorded operation and verified filesystem evidence. Library
  recovery stops on divergent evidence; Author sync can merge newly authored edits.

General coding rules live in [coding standards](../docs/coding-standards.md).
Product terms live in [CONTEXT.md](../CONTEXT.md). Durable rationale lives in
[ADRs](../docs/adr/); proposals, migration plans and progress belong in Arc Work.

## Checks

- `boundaries.mjs` defines private-import and permitted-service rules.
- `layout.mjs` defines placement and import direction.
- `app.ts` supplies owner identities and the core package export contract.
- `conformance/` checks selected API signatures and dependency requirements.
  Library member names are checked, but independent signatures cover only `read`,
  `plan`, `apply`, `import`, `setup`, `content`, `history`, `recovery` and `startup`.
  These checks do not prove runtime correctness.

Run the smallest checks relevant to a change, following [AGENTS.md](../AGENTS.md).
For architecture types, run `node node_modules/typescript/bin/tsc -p architecture/tsconfig.json`.

To check that an implementation preserves an approved architecture, choose a
reviewed full commit SHA and run the checker from that commit:

```sh
git show APPROVED_SHA:scripts/check-architecture.mjs | node --input-type=module - --base APPROVED_SHA
```

This rejects changes to protected contracts, rules and allowances, including new
inline suppressions. It inspects committed and uncommitted changes and requires
installed dependencies. Keep the checkpoint fixed until the task is accepted.
Passing this gate does not establish that lint, behavior or the owner migration
passed. An intentional contract change needs its own review.
