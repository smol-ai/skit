# Using the architecture locally

`boundaries.mjs` and `layout.mjs` feed lint rules for private imports, permitted
services, placement and import direction. `app.ts` supplies owner identities and
core package exports to the structure checker and lint. Its module/state labels
are navigation, not a compiler-verified service graph.

`conformance/` checks selected independent API declarations. For Library, all
member names are checked, but independent signatures cover only `read`, `plan`,
`apply`, `import`, `setup`, `content`, `history`, `recovery` and `startup`.
The other operation names are listed in `LibraryOperation`; their signatures are
not independently enforced here. Constructor requirements are checked against
`LibraryRequires`. Author checks live separately in `conformance/author.ts`.
Passing these checks does not establish runtime correctness or complete Library
signature coverage.

`decisions.md` retains design rationale. Historical migration checklists and
progress belong in Arc Work rather than executable architecture declarations.

## Read the core/CLI boundary

`packages/skit` is the `@smolai/skit-core` package. It owns Library policy,
plans, mutations, locks and recovery. `packages/cli` is the `@smolai/skit`
application: command grammar, terminal interaction and process execution.

Start at a command in `packages/cli/src/commands/` and follow its calls to core.
CLI output schemas and rendering functions can be imported directly from their
modules. A folder does not need a sibling re-export file.

| Core package entry                                      | Responsibility and current operation boundary                                                                                                                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library`                                               | `Library.Service` and its captured owner methods: `addSource`, `importSource`, `remove`, `update`, `edit`, queries, `inventory`, `enable`, `session`, `sync`, `syncSession`, `plan`, `apply`, `setup`, `history`, `recovery` |
| `library/source`                                        | Source requests, parsing and passive `inspectSource`; mutation goes through `Library.addSource` / `importSource`                                                                                                             |
| `library/queries`                                       | Report schemas and query vocabulary; execute reports on Library methods                                                                                                                                                      |
| `library/session`                                       | Interactive session vocabulary and pure choice helpers; open with `Library.session.open`                                                                                                                                     |
| `library/enable`                                        | Selection/result vocabulary and reviewed-plan application; open with `Library.enable.open`                                                                                                                                   |
| `library/update`, `library/edit`                        | Update/edit vocabulary and review helpers; start with `Library.update` / `edit`                                                                                                                                              |
| `library/sync`                                          | Transport/session vocabulary and reviewed sync helpers; start with `Library.sync` / `syncSession`                                                                                                                            |
| `library/recovery`                                      | Compatibility recovery workflows; passive facts are `Library.recovery.list` / `inspect`, restores use owner plans                                                                                                            |
| `library/setup`                                         | Setup scanning, review and application workflow over Library and MachineSettings                                                                                                                                             |
| `library/routing`, `library/inventory`, `library/usage` | Device routing, inventory vocabulary and local transcript reports                                                                                                                                                            |
| `machine-settings`                                      | Device-local roots, repository choices and independently durable setup-settings undo                                                                                                                                         |

These are package subpaths from `packages/skit/package.json`, not one public
service per row. Removal and security operations have no separate package entry:
use `Library.remove`, `securityReview` and `acceptSecurityFinding`. Owner-private
implementations live under `library/internal/`; `architecture/app.ts` records
their ownership rather than granting callers storage access.

`packages/cli/src/application.ts` defines concrete owner layers. `commands/tree.ts`
uses Effect CLI's `Command.provide` to supply them to the selected command. Groups
inherit configuration flags with `Command.withSharedFlags`; flat Library commands
pass their parsed flags directly to the Library layer. Registry configuration,
authentication, repository settings, feedback and version do not open Library.

The root command supplies platform, prompt and progress services once around
selected execution. `commands/runtime.ts` owns the execution scope and one failure
renderer covering parsing, owner construction and execution. `main.ts` supplies
the process configuration and Renderer. An explicit home derives from that
configuration snapshot. Command handlers call owners and render results; they do
not select runners, provide application layers, or open Library storage.

For example, enable/disable follows:

```text
commands/library-enable-command.ts       parse flags and scope
  → library/enable.ts                    collect choices and render outcomes
    → Library.Service.enable.open()      capture the owner's selection view
    → selection.plan(intent)              review without holding a writer
    → applySetEnabledPlan(plan)           apply the captured owner's reviewed plan
      → private Library implementation    own freshness, writes and recovery
```

The prompts stay outside writer scopes; core owns the plan and its application.
We enforce resource and owner privacy, not the number of calls in a generator.
Several calls across a preview/prompt/apply interaction are legitimate.

Add follows a shorter path:

```text
commands/library-add.ts              flags, preview/add choice, progress and rendering
  → registry/library-source.ts       locator and credential selection → SourceRequest
  → inspectSource(request)           passive preview via library/source
  OR Library.Service.addSource(request)
    → private source operation       source policy, acquisition/import lifetime and description report
```

The command passes the source result directly to its output schema. It does not
reconstruct credentials, enforce source policy or issue a second Library query.

`import-direction` rejects core dependencies on workspace applications,
undeclared core package subpaths, and cross-package relative imports into core
source or build output. It checks static imports/re-exports, literal dynamic
imports and type-expression imports. Core and CLI have no tsconfig path aliases;
Arbitrary aliases and nonliteral dynamic targets are not resolved by this check.
Export maps and these direct-edge checks do not prove transitive runtime safety; universal-entry tests
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
