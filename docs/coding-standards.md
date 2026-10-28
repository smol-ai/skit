# Coding standards

## Design modules around ownership

Apply the Single Responsibility Principle to decisions that change for the same
reason. Keep the rules, state, and lifecycle needed to fulfill a responsibility
together. A responsibility can span several steps; SRP does not mean one function
or module per step.

Prefer deep modules: small interfaces that hide substantial complexity. Callers
should express intent and receive useful results without knowing internal
sequencing, storage representations, or recovery procedures. Keep implementation
details private unless a real consumer needs them.

Judge a boundary by what callers no longer need to know. Explain what a new
abstraction hides and why that justifies its interface. Avoid wrappers that leave
callers responsible for assembling the same lifecycle or enforcing the same rules.

## Name things plainly

Use the simplest words that say what a thing is or does. A reader who knows
SKIT's commands, but not its internals, should understand a name without a
glossary. Name the concrete thing, not the category it belongs to: a skills.sh
lock file entry is `SkillsShLockFileEntry`, not an observation; the folder SKIT
writes into an agent's skills directory is an `InstalledSkill`, not a
projection.

Give each word one meaning across the codebase. Before introducing a term, check
`CONTEXT.md` and existing code; if the word already means something else, pick
another. When code uses one word for two things, rename one of them rather than
qualifying it in comments.

Use the verbs in `CONTEXT.md`'s verb table, each in its one meaning, and none
of the words it lists to avoid. A function that loads saved state says `load`; one
that walks skills directories says `scan`; one that scans and saves says
`refresh`. If an operation needs a verb the table lacks, add it there first.
Call a hash a hash: a `sha256:…` value is a `Hash`, not a digest.

Do not introduce intermediate terms or types. If data passes through a second
shape that differs only by being unchecked, recased, or partially built, remove
that shape: let the producer build the final value through one constructor that
does the checking. Two names for one thing ("entry" and "record", "observation"
and "evidence") are a sign that one of them should not exist.

Say one or many in the noun. A function acting on one thing takes the singular
(`uninstallSkill(copy)`), one acting on several things it is given takes the
plural (`uninstallSkills(copies)`), and one that also decides which things names
its rule (`leftoverSkills(state)`, `installEnabledSkills(...)`). Prefer separating
choosing from acting when the choice is useful on its own.

Do not encode the type in the name. An Effect-returning function is not named
`...Effect`; a schema is not named `...Schema` unless a plain value of the same
name also exists.

Rename stored names (state file fields, manifest keys, ownership markers, history
event names) only together with a migration in the store loader. Published
contract names, released CLI flags, and Registry wire names change only with a
contract or compatibility decision.

## Investigate Effect v4 APIs before building utilities

Before hand-rolling infrastructure or general-purpose helpers, check whether the
installed Effect v4 version already provides the capability:

1. Search this repository for established usage and conventions.
2. Inspect the pinned package version and its exports, types, and source.
3. Consult official v4 documentation, upstream source, or the Effect Grep corpus
   for additional examples. Verify examples against the installed version.

Do not assume an API remembered from Effect v3 or a v4 prerelease still applies.
The installed package is the authority for API availability and signatures.

Pay particular attention to resource lifetimes, concurrency, retries, scheduling,
caching, streams, configuration, schemas, collections, and error handling. Check
semantics as well as names: lifetime, interruption, failure, concurrency, and
eviction behavior must fit the operation.

Prefer an existing API when its semantics fit and it makes the code clearer. Keep
custom code when it expresses domain policy or is simpler than adapting an
unsuitable abstraction. Do not replace straightforward domain code with Effect
machinery solely because an API exists.

When introducing a substantial custom utility, explain in the PR which existing
APIs were considered and why they did not fit. Keep this proportional to the
decision; ordinary application code does not need an API research report.

## Refactor toward a concrete improvement

Before a substantial refactor, identify:

- The knowledge or coordination currently spread across callers.
- The module that should own it and the interface it should expose.
- The behavior and invariants that must survive the change.

Sketch before/after Markdown call graphs before implementation. Use them to
challenge the proposed boundary, then update them to match the final code for the
PR. Show responsibilities alongside calls so that moving code cannot masquerade
as transferring ownership.

Moving code, splitting files, extracting helpers, and reducing line count can
support a refactor, but do not establish that the design improved. Show the
decisions, duplicated rules, or coordination steps removed from callers. Explain
tradeoffs, including new concepts or interfaces introduced.

Preserve transaction and resource ownership. For Library operations, passive
previews and interactive questions stay outside writer scopes; mutations
revalidate under their writer. A prepared operation must retain the inputs and
revision needed to ensure that applying it matches the reviewed intent.

## Demonstrate ownership changes in PRs

Meaningful refactor PRs must include before/after Markdown call graphs based on the
actual base and final revisions. Name the compared revisions. Condensed graphs
are welcome: identify omitted detail and retain enough to expose remaining caller
coordination. Use fenced `text` blocks so the graphs are readable directly in the
PR.

For example, the Library binding boundary introduced in `2edcaf061`, compared with
`41cb74344`, can be summarized as follows (low-level calls and rendering omitted):

```text
Before
CLI enable/disable handler / TUI Library session
├─ interpret raw Library state and derive per-Scope changes
├─ collect choices and track confirmation revision
└─ coordinate binding preview/apply and writer ownership

After
CLI / TUI
├─ openBindingChangeSelection → captured Library view
├─ selection.preview(intent) → facts to render and confirm
└─ applyBindingChanges(captured plan)
   └─ owns writer, freshness checks, publication, reconciliation
```

The useful result is that callers no longer interpret raw Binding layout or
construct per-Scope requests. Another example is `d918156fa`: historical document
schemas and migration decisions moved behind storage boundaries, allowing
consumers to use the current representation.

Each meaningful refactor PR should explain:

- **Problem and ownership change:** what callers previously needed to know, what
  the new owner handles, and what callers can forget.
- **Before/after call graphs:** actual responsibility and call changes, including
  remaining coordination and any tradeoffs.
- **Validation:** evidence that affected behavior and invariants hold. Distinguish
  checks run locally from CI results and unverified expectations.

Run the smallest relevant checks, following [AGENTS.md](../AGENTS.md#validation).
