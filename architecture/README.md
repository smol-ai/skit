# Using the architecture locally

`app.ts`, `library.ts` and `author.ts` describe the intended owners and interfaces.
`conformance/` checks actual signatures and requirements. `boundaries.mjs` controls
private imports and service identities; `layout.mjs` controls placement and import
direction. Existing debt is a list of violations, not approval of their design.

## Read the core/CLI boundary

`packages/skit` is the `@smolai/skit-core` package. It owns Library policy,
plans, mutations, locks and recovery. `packages/cli` is the `@smolai/skit`
application: command grammar, terminal interaction and process execution.

Start at a command in `packages/cli/src/commands/`, follow its feature entry in
`packages/cli/src/library/`, and then the named core API:

| Core entry | Responsibility |
| --- | --- |
| `library/queries` | Passive reports and Skill metadata |
| `library/session` | Interactive Library state, choices and transitions |
| `library/enable` | Enable/disable selection, reviewed plans and outcomes |
| `library/update`, `library/edit` | Source updates and reviewed local edit imports |
| `library/remove` | Removal selection and reviewed plans |
| `library/sync` | Library sync sessions and outcomes |
| `library/recovery` | Recovery inspection and reviewed restores |
| `library/security` | Review and acceptance of security findings |

`packages/cli/src/application.ts` constructs the production owner layers and
supplies command configuration, terminal services and failure rendering.
`commands/runtime.ts` runs the CLI grammar; `main.ts` supplies the Node process
environment. Commands do not construct the Library or open its storage.

For example, enable/disable follows:

```text
commands/library-enable-command.ts       parse flags and scope
  → library/enable.ts                    collect choices and render outcomes
    → @smolai/skit-core/library/enable    open selection → plan intent → apply reviewed plan
      → private Library implementation   own freshness, writes and recovery
```

The prompts stay outside writer scopes; core owns the plan and its application.
Several calls across this interaction are legitimate. `frontend-one-owner-call`
only flags multiple directly imported owner calls in one Effect body; it does
not follow helpers or callbacks and is not proof of ownership.

`import-direction` rejects core dependencies on workspace applications,
undeclared core package subpaths, and cross-package relative imports into core
source or build output. It checks static imports/re-exports, literal dynamic
imports and type-expression imports. Core and CLI have no tsconfig path aliases;
arbitrary aliases and nonliteral dynamic targets are not resolved by this check. Export maps and these
direct-edge checks do not prove transitive runtime safety; universal-entry tests
separately inspect the runtime-neutral graph.

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

## Private means private, regardless of the exported name

Library's storage implementation (`library-store`, `state-file`, `writer-lock`)
and `library/internal/` can be imported only inside Library. Inside Library, only
`library/store/` imports `state-file`: every change saves through the
`LibraryWriter` that `writeLibrary` provides while it holds the home lock.
Package-local implementation tests can inspect private evidence without opening an
owner that would recover it. There is no core root entry: applications use the
declared owner or shared subpaths. The Library entry exposes the current snapshot
codec for serialized-state validation; storage, historical migration and recovery
remain private.

The rule covers named imports, aliases, namespace imports, side-effect imports,
re-exports and literal dynamic imports. A new export name does not grant access.
Named private exports through public package entries are separately checked.

## Accept one operation, not a folder move

For Library enable/disable, acceptance must demonstrate that CLI and TUI use the
shared core operation/read model without opening stores, constructing owners or
sequencing writers. Preserve reviewed-intent freshness, partial outcomes and
installed-copy protection. Name the construction/import sites that disappear and
show the final caller flow. Passing the baseline check alone does not satisfy this.
