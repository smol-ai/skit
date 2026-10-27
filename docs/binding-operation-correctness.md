# Enable/disable correctness

Baseline: `03146480e33e8d6f3d64ea922c0c12f427596d0f`.
The comparison is against the working tree on `refactor/setup-recovery`.

## Current trace before implementation

```text
CLI / Library session
  -> captured selection.preview(intent, routing) [Library revision + private requests]
  -> applyBindingChanges(plan) [Library writer]
       -> recheck home + revision
       -> applyChange
            -> recalculate desired binding; check duplicates/custody/writable roots
            -> publish binding intent [durable decision]
            -> reconcileLibraryProjections [may partially write and then fail]
            -> prune empty bindings; load recorded projection outcomes
  -> CLI interprets projection.status to choose exit 12
  -> session treats every successful return as "applied"
  -> ordinary typed error after publication loses the saved-intent distinction
```

The application already owns planning, writer acquisition, freshness and effects.
The missing ownership is deciding what the saved intent and destination outcomes
mean together. A caller should not infer successful installation from command
acceptance, nor infer rejection from a later filesystem failure.

## Implemented boundary

```text
CLI / Library session
  -> captured selection.preview(intent, routing) [revision + active target set]
  -> applyBindingChanges(plan) [same writer; coherent publication revision]
       -> reject changed Library/agent targets before publishing
       -> recheck duplicate/custody/root conditions
       -> publish desired binding
       -> reconcile only captured targets; guard every native publication's base
       -> check each selected destination against the recorded projection outcome
       -> report intent saved/unchanged + known Library revision + completion
       -> on typed failure after acceptance, carry the recorded partial outcomes
          and original classification; stop before the next requested scope
  -> CLI translates application completion/classification to versioned output + exit
  -> session refreshes authoritative facts and reports the application's failure
```

The owner retains previously completed scope results if a later scope fails.
Pre-publication refusals remain failures. A completed installation result requires
all selected enabled destinations to be recorded installed, or the disabled copies
to be absent from the selected roots. A partial outcome must not claim that an
unreadable or unwritten destination is installed. Snapshot facts describe the last
known recorded state, not a fresh filesystem inspection after failure.

This slice keeps the existing Library writer, state-file publication and native
projection reconciliation. It adds no persistence engine, transaction journal,
Domain runtime, new service or automatic retry. The installed Effect 4.0.3
`Effect.result` captures typed failures while preserving defects and interruption;
use it only around the post-acceptance work. Prompts remain outside the writer.

## Verification and tradeoffs

`binding-changes.test.ts` uses real retained artifacts, Library publications and
filesystem destinations. Its final-state tests establish:

- Refused publication and changed target/revision reviews install nothing.
- A second-target I/O failure leaves accepted intent and the first installed copy
  intact; a fresh preview/retry installs the missing copy.
- Disablement can save desired removal while refusing to retire an edited active
  copy; restoring baseline bytes and retrying completes it.
- An accepted scope's incomplete result preserves earlier completed scope results
  and stops later requests. A later pre-acceptance refusal is reported separately.
- A non-cooperating state change after intent publication is preserved, rather
  than being silently rebased by native projection publication.
- Typed failures become explicit incomplete outcomes. Defects and interruption
  keep their original Effect semantics.
- The session refreshes saved bindings and reports installation failure. Literal
  CLI grammar produces the v9 incomplete result and conflict exit 12; the CLI
  adapter preserves I/O exit 1. Rendered output does not claim full enablement.

`library-set-enabled.test.ts`, `library-session-invocation.test.ts`,
`library-commands.test.ts` and affected setup tests retain existing scope, policy,
custody and composition behavior. Setup's deliberate source-adoption workflow can
accept an incomplete **destination** result as a warning while differing copies
remain active. It does not accept an actual reconciliation failure or proceed with
unverified duplicate cleanup. This policy stays in the setup application owner,
rather than becoming a CLI exception or a global success shortcut.

`skit.enable.v9` and `skit.disable.v9` add `application.intent`, the last known
recorded `revision`, `status`, and classified failure facts. Plan schemas remain
v8. Complete results return normally; `BindingChangeIncomplete` carries recorded
results plus the original failure classification. A partial result's revision is
explicitly the last known revision from this operation, which may differ from
current disk state after an external change. It is not live installation proof.

The code grows because it makes a previously implicit partial-commit state
explicit. The correctness argument is shorter: only the binding owner combines
acceptance, recorded destinations and failure phase. Clients neither infer success
from a zero-return nor reconstruct it from raw projection statuses. Reconciliation
still cannot promise a transaction across filesystem trees and Library state;
interruptions/defects may need a new observation rather than returning a result.
No automatic retry or rollback hides those boundaries.

Local validation completed:

- CLI TypeScript build/typecheck and targeted lint/format checks.
- Focused binding, Library command/session/invocation and affected setup tests,
  including real-file failure injection and the parsed/rendered CLI path.
- Exact generated-contract tests and compatibility against `03146480e`.
- Packaged CLI: unchanged enable plan v8, incomplete enable v9 with exit 12,
  preservation of foreign bytes, successful enable with the intended bytes in both
  selected roots, and disable v9 removing only owned copies.

No core/server code or persistence contract changed. No full workspace suite was
run. These changes remain uncommitted; no push or deployment was performed.
