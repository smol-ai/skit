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
