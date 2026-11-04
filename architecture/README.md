# Using the architecture locally

`app.ts`, `library.ts` and `author.ts` describe the intended owners and interfaces.
`conformance/` checks actual signatures and requirements. `boundaries.mjs` controls
private imports and service identities; `layout.mjs` controls placement and import
direction. Existing debt is a list of violations, not approval of their design.

## Check a working tree against an approved checkpoint

Choose an exact commit whose architecture and checker have been reviewed. Keep
that SHA fixed while an implementation agent works. Do not advance it merely
because another implementation commit was made.

Run the checker from that commit, rather than the working tree:

```sh
# Replace APPROVED_SHA with the reviewed checkpoint's full SHA.
git show APPROVED_SHA:scripts/check-architecture.mjs | node --input-type=module - --base APPROVED_SHA
```

This rejects new debt entries, expanded allowances, changed approved rules,
changes to the existing contracts/checker/lint tests, and new inline lint
suppressions. Candidate policy modules are parsed as literal data; they are not
executed. The command inspects committed, staged, unstaged and untracked changes
relative to the checkpoint. It requires the checkout's installed dependencies.

After that check passes, run the actual enforcement and the smallest relevant
behavior checks. For example, the import rules and architecture types are:

```sh
node_modules/.bin/oxlint packages/skit/src packages/cli/src packages/tui/src
node node_modules/typescript/bin/tsc -p architecture/tsconfig.json
```

A baseline PASS only means no forbidden rule/debt change. It does **not** mean
that the assigned owner migration is finished, lint passed, or behavior passed.
Use the same pinned checkpoint until that bounded task is accepted. An intentional
architecture/enforcement change needs its own review and a new accepted checkpoint.

This is a local acceptance gate, not a filesystem sandbox. An agent with shell
access can ignore a command. Its result becomes authoritative only when the user
or an independent runner chooses the SHA and executes the pinned command.

## Size only falls

Debt lists track where code sits, not how much there is. `size.mjs` records approved limits for
source lines per package, names exported per package entry point, and files reachable from each CLI
command. The pinned check fails when the working tree measures above the checkpoint's limits.
`lint/size-ratchet.test.ts` also fails on a stale limit, so a shrink lowers its number in the same
change. Raising a limit or adding a command is an architecture change with its own checkpoint.
Moving code behind a new owner without deleting the old path therefore fails.

## Private means private, regardless of the exported name

Library's storage implementation (`library-store`, `state-file`, `writer-lock`)
and `library/internal/` can be imported only inside Library. The compatibility
root barrel and package-local implementation tests have explicit access. Shared
schema modules retain their existing vocabulary role.

The rule covers named imports, aliases, namespace imports, side-effect imports,
re-exports and literal dynamic imports. A new export name does not grant access.
Named private exports through public compatibility barrels are separately checked
against the existing debt list.

## Accept one operation, not a folder move

For Library enable/disable, acceptance must demonstrate that CLI and TUI use the
shared core operation/read model without opening stores, constructing owners or
sequencing writers. Preserve reviewed-intent freshness, partial outcomes and
installed-copy protection. Name the construction/import sites that disappear and
show the final caller flow. Passing the baseline check alone does not satisfy this.
