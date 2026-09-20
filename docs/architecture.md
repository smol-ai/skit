# Architecture

> **V1 scope:** Authoring, Draft synchronization, and Publication below describe pre-release
> server capabilities. The v1 CLI supports Registry synchronization and distribution and does
> not expose those authoring workflows.

SKIT is a lossless local library and distribution system for agent skills. It separates what an artifact is, where a copy is located, how that copy was derived, and whether SKIT manages it.

SKIT is a strict package-level extension of Agent Skills rather than a replacement format. The ownership of `SKILL.md`, `skit.json`, Registry metadata, Library intent, and device-local evidence is defined in [Agent Skills compatibility](agent-skills-compatibility.md).

```text
source --add/pull--> local library --enable/disable--> harness × scope
local SKIT --------------------------publish--------> registry
```

This document describes the current system. Durable reasons for choices that are expensive to reverse belong in architecture decision records; implementation and contribution procedures belong in the [development guide](development.md).

The [user journeys](user-journeys.md) define the product outcomes this architecture must support and distinguish complete journeys from commands that merely exist.

## Architectural invariants

The following rules define the system:

- Adding a source does not enable any skill.
- Source originals and normalized releases have different identities and are retained separately.
- `state.json` is the authoritative record of managed local state.
- Harness projections are derived filesystem effects, not independent sources of truth.
- Bindings express desired enablement; library entries retain artifacts; projections record materialized copies.
- Harness Availability is device-local; an unavailable Harness defers its Projection without changing portable Binding intent.
- Sources are canonicalized as structured `SourceIdentity` values; Collections have opaque stable IDs and human labels.
- Core owns state persistence and serialized Projection mutation.
- Published versions are immutable. An existing owner, SKIT, and version tuple cannot be replaced.
- Local Library operations, Library synchronization, and Draft synchronization never constitute Publication; only an explicit, reviewed publish operation may create a distributable Release.
- Human-readable CLI output and versioned JSON output are presentations of the same command result.
- Stable and experimental command surfaces are explicitly separated.
- Library Management, Projection and Custody, Artifact integrity, and Distribution reads do not
  depend on Authoring, Draft, or Publication workflows. Optional write capabilities depend inward
  on capability-neutral Artifact, identity, invocation, and protocol contracts.

Changes that violate one of these rules are architectural changes rather than local refactors.

## Package boundaries

| Package                                                      | Owns                                                                                                                                                         | Does not own                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `packages/skit` (`@smolai/skit-core`)                        | SKIT schemas, validation, source acquisition, hashing, archives, shared HTTP contracts, local-library state, and Projection mutation                         | Terminal interaction, process exit behavior, or registry storage     |
| `packages/cli` (`@smolai/skit`)                              | Argument parsing, command dispatch, human and JSON presentation, harness selection and probing, publishing workflow, and capability auditing                 | Independent persistence of authoritative local state                 |
| `packages/skit-server-effect` (`@smolai/skit-server-effect`) | Discovery, Better Auth accounts, PAT authentication, domain grants, portable Library revisions, immutable release metadata in D1, and release archives in R2 | Device-local library policy, harness selection, or terminal behavior |

Both the CLI and server depend on core. Core does not depend on either application package.
The Registry Worker imports core through runtime-neutral universal surfaces. Consumer capabilities
use `@smolai/skit-core/universal/consumer`; optional Draft and Publication capabilities extend it
through `@smolai/skit-core/universal/authoring`. Canonical schemas remain owned once, while Worker
adapters own Web Crypto hashing, Cloudflare bindings, persistence, and transport-specific error
translation. Both universal import graphs must remain loadable under workerd and must not reach the
Node platform layer.

Descriptor parsing and projection hashing belong to Artifact integrity, even when Authoring and
Publication also consume them. Author Workspace metadata participates in the Library through a
focused service; Author initialization creates it, but Library workflows read it without importing
an Author command workflow. Registry discovery advertises only the optional capabilities and
authentication scopes that its composition actually provides.

```text
CLI ────────┐
            ├──> core
server ─────┘
```

Within the CLI, command orchestration depends on focused adapters and shared audit types. Audit adapters do not depend back on the audit orchestrator.

## CLI execution ownership

[ADR-0018](adr/0018-own-cli-workflows-with-effect.md) defines the Effect execution model.
The CLI runs one application fiber through NodeRuntime; native handlers compose
startup reads, workflows and rendering without internal runtime entry. Platform,
Renderer and RegistryHttp dependencies are provided at the application boundary.
Publication is the reference workflow; listing is the simpler pagination example.

Native operation scopes own cleanup on failure and interruption. Real SIGINT/SIGTERM
tests cover HTTP abortion and publication temporary-file cleanup. This does not undo accepted
Registry writes or make `SIGKILL` cleanup guarantees.

Promise handlers remain behind an explicit transition adapter that waits for settlement
on interruption. They are not yet cancellation-safe; their nested runtimes and mutation
lifetimes remain migration work. Pure domain helpers and the existing contract schemas
do not need to become Effect services.

## Domain model

### Source

A source records a locator and acquisition policy: a registry reference, Git reference, local directory, archive, or URL. A Library Entry associates the retained artifact with that source, its resolved revision, retained original, normalized artifact, and contained Skills. Provenance is the derivation history of an artifact instance, not another name for its source.

The supported locators, current check behavior, and candidate version signals are listed in
[Sources and version checks](sources-and-version-checks.md).

`sourceId` identifies the origin coordinate. It is not a SKIT identity or content digest.

### SKIT and skill

A SKIT is an Agent Skills-compatible package extended by its machine-owned `skit.json` Descriptor. An authoritative Registry associates that package with a stable SKIT Identity and Release history. SKIT Identity includes Registry authority, Namespace, and SKIT slug and is rendered canonically as `skit://<registry-authority>/<namespace>/<skit>`; a bare `namespace/skit` is shorthand only within an explicitly selected Registry. The Descriptor can be unbound, in which case it has no `id`: its slug and contained-skill declarations establish local authoring intent without claiming Registry identity. A root `skit.remote.json`, not a Descriptor string sentinel, records the repository's author home. Human documentation such as `README.md` remains ordinary artifact content. README-frontmatter Descriptors use `slug`; namespace-shaped `local/*` provisional IDs are rejected. A Draft or Release is concrete SKIT content, and a standalone Skill or descriptorless Agent Skills package can exist without a SKIT Identity.

Important identifier spaces are deliberately separate. Persistent entities use branded opaque IDs;
source locators and labels are not IDs:

| Identifier            | Meaning                                                   |
| --------------------- | --------------------------------------------------------- |
| `collection_id`       | Stable identity of Skills acquired and managed together   |
| `skill_id`            | Stable identity of one retained Skill                     |
| `skill_version_id`    | Stable identity of one retained Skill version             |
| `skitId`              | Declared SKIT identity, present only for declared SKITs   |
| `release`             | Declared immutable version                                |
| `releaseContentHash`  | Digest of normalized release content                      |
| `originalContentHash` | Digest of the losslessly retained source tree             |
| `projectionId`        | One materialized skill copy at a concrete harness target  |

Hashes establish content identity; they do not replace readable source, SKIT, or skill identities.

### Binding

A Library Binding records desired enablement for a Harness, Scope, and set of Skill IDs. Its Scope
is either global or tied to a canonical repository root.

Bindings describe intent. They do not prove that files are currently present or unchanged.

In accordance with [ADR-0008](adr/0008-defer-bindings-for-unavailable-harnesses.md), a device reconciles Bindings only for locally available Harnesses. Bindings for unavailable Harnesses remain portable desired state and become eligible for Projection when the Harness later becomes available; they are not pruned, materialized into speculative roots, or classified as conflicts.

### Library entry and projection

A Collection groups Skills acquired and managed together and may record an upstream Source. Each
Skill retains its versions and Acquisition provenance. Each managed Projection records one concrete
Skill copy at a Harness target and its observed status:

- `pending`
- `installed`
- `drifted`
- `conflicted`
- `unsupported`

Projection directories include ownership metadata linking materialized content to its Skill ID,
Skill Version ID, expected hash, and Projection ID. This allows SKIT to distinguish managed content
from unmanaged or modified content.

In accordance with [ADR-0006](adr/0006-materialize-independent-writable-projections.md), each writable Projection is an independent directory rather than a symlink to the retained artifact or another Harness's Projection. Harness-side changes therefore produce local drift without mutating Author content, retained content, or sibling Projections.

### Projection suppression, history, and unmanaged observation

The local state also retains:

- current native-deletion suppression on the affected Projection;
- observations of unmanaged harness content.

Device-local `audit.jsonl` separately records diagnostic semantic history. It is appended
after authoritative state publication, so a crash may omit the final event. Audit history
never drives reconciliation. These boundaries support reconciliation and diagnosis without
treating every file found in a harness root as SKIT-owned.

## Authoritative state and filesystem effects

The default local library is `~/.skit`, overridable with `SKIT_HOME` or `--home`. Its `state.json` is the single authoritative metadata store. Content-addressed originals and normalized releases live alongside it.

The core `LibraryStore` Layer owns fresh state loads and validated atomic publication. Standalone `refreshInventory` composes its load, read-only `observeInventory`, and completed observation publication; the CLI provides the store at application startup. Standalone `setProjectionEffect` owns one core enable/disable mutation through the acquired store. CLI code must use these core boundaries rather than implement a second state writer.

Projection changes use one serialized, scoped mutation:

```text
load authoritative state
        ↓
resolve bindings and concrete targets
        ↓
materialize all changed projections
        ↓
persist the new state once
```

Foreign or drifted content is not silently overwritten. Materialization uses ownership markers and observed hashes to decide whether an operation is safe, a no-op, or a conflict.

## Operation flows

Projection mutations prepare replacement trees in scoped random directories on the destination
filesystem, verify custody, apply the derived directory changes, and atomically publish candidate
Library state once. Failure before publication leaves the prior state authoritative; retrying the
mutation reconciles missing or managed-stale Projections from retained content. Foreign or modified
content remains protected. See [ADR-0020](adr/0020-treat-projections-as-reconcilable-derived-state.md).

This native boundary covers core `setProjection`, each normalized CLI Binding batch,
and complete local author initialization/registration.
Install, update, remove, Binding reconciliation, and author refresh share this mutation and
custody policy in `projection/mutation.ts`.

### Author initialization

`author init` owns scaffold creation, workspace identity, local retention and registration
under the application runtime. A durable `.skit/init-scaffold` checkpoint lets interrupted
fresh scaffolds resume without overwriting existing files. Workspace identity is published
atomically and exclusively before retention; retries reuse it. Both retained representations
come from a verified Original and share the existing hash and copy policies.

One Projection mutation commits the Entry, Installation, removed-Skill retirement,
surviving Binding refresh and current suppression. Bindings retain missing names and overrides as
dormant intent; descriptor defaults never enable acquired Skills. Workspace registration is
finalized after this commit. A failed finalization leaves the Library authoritative and
retry repairs the marker, including an interrupted `--register` transition. Scaffold and
identity files and verified immutable objects may survive failure; temporary copies do not.
See [the commit protocol](adr/0018-own-cli-workflows-with-effect.md#author-initialization-commit-protocol-issue-13).

### Add and pull

`add` resolves a Source, retains its Original tree, validates and normalizes its content, stores both
trees content-addressably, canonicalizes the Source, and writes the Collection and its Skills.
Descriptorless Collections do not receive a synthetic SKIT identity.

A Collection contains one or more Skills acquired and managed together. Every Skill in the Library
belongs to a Collection, including a single Skill added from a local directory or adopted during
setup. A Collection's identity names its origin, not the selected members; selected Skill names and
paths are stored as update policy.

An upstream records refresh intent; an Acquisition records where retained bytes came from. Local
Collection acquisitions are provenance, not portable refresh intent, so `check` reports their
source status as not applicable and `update` refuses them. Re-adding the same local path records a
new Acquisition on the existing Collection.

`pull` reacquires a recorded origin. It updates stored source and release information while preserving binding intent. `check` reports whether changes are available; `update` applies them.

None of these operations enables a skill merely because it was acquired.

### Enable and disable

Enablement resolves a Collection or Skill query to stable IDs, plus target harnesses and global or
repository scope. The CLI discovers or accepts explicit harness roots, then asks core to update
bindings and materialize projections.

A batch spanning subjects or Harnesses loads one coherent state snapshot and stages Bindings and
all affected Projections against one private candidate. The candidate is published once after the
derived filesystem work succeeds. Retry reconciles any managed Projection divergence.

Explicit no-prompt commands, including `--all` and `--dry-run`, participate in the
application Effect lifetime. Preview is read-only.
Stored previews guard Entries/Bindings revision before writes.
Interactive prompts and separately confirmed session operations remain compatibility
boundaries; each submitted normalized mutation uses the native batch. See
[ADR-0018](adr/0018-own-cli-workflows-with-effect.md#binding-batches-and-explicit-enabledisable).

Disablement removes the selected binding intent and safely removes projections still owned by SKIT. Drift or foreign ownership is surfaced instead of destructively erased.

### Inventory and doctor

`inventory` refreshes authoritative state against selected Harness roots, including unmanaged content, then publishes one complete observation after all roots succeed. The standalone observer clones its input and performs no writes; presentation filtering follows persistence. `doctor` reports inconsistencies requiring attention. Observation is distinct from adoption: finding a directory does not make SKIT its owner.

### Publish and download

The CLI validates a local SKIT, creates a deterministic archive, discovers registry routes, and submits a versioned publish request. Core owns the request and response schemas used by both client and server.

The reference server:

1. advertises relative route templates at `/.well-known/agent-skills/`;
2. validates and bounds the publish request;
3. recomputes semantic validation when draft revisions are written;
4. rejects revisions with blocking diagnostics and verifies every archive path, byte length, and digest against the selected current draft revision;
5. stores the archive in R2;
6. stores immutable release metadata in D1;
7. compensates by removing the archive if the metadata write fails;
8. serves exact versions or the most recently published release through `latest`, enforcing Release visibility before reading private archive bytes.

Exact release downloads are immutable. Public and unlisted Releases can be downloaded without an account; private Release metadata and bytes require individual or current team authority and are never protected merely by an R2 object key. Publishing the same owner, SKIT slug, and version twice returns a conflict. Once a SKIT has a remote draft, publication must name its current immutable draft revision.

### Identity, authorization, and Library synchronization

Better Auth owns email/password accounts and secure browser sessions. CLI automation uses separately revocable `skit_pat_` credentials whose hashes, scopes, expiry, generation, and last-use evidence are stored in D1. Both credential kinds normalize to an opaque SKIT Principal before domain authorization; route handlers do not treat a username, namespace string, descriptor ID, or bearer possession as authority by itself.

Namespaces are controlled by an individual Principal or a registry-local team. Current team membership participates in Authorship, Publication, Library, and private Release access, so removing a membership removes authority on the next request. Authorship and Publication Grants remain distinct. Suspending a Principal or advancing its authorization generation invalidates previously issued credentials without rewriting every PAT.

The server retains immutable revisions of each principal's portable Library Manifest using optimistic concurrency. These revisions contain Library Entries and Bindings only. In accordance with ADR-0001 they reject device-local Projection, Custody, paths, observations, ownership markers, drift, conflicts, suppression, and audit history rather than importing those fields into portable intent.

### Draft synchronization

Remote drafts are immutable revisions behind one guarded current-draft head. Draft files are content-addressed in R2; D1 records revision ancestry, metadata, manifests, and the selected head.

`sync` records the common revision and per-file baseline in the local SKIT home. It compares that baseline with the local working tree and current remote draft, then either reports a clean state, produces a read-only merge plan, or surfaces conflicts. `--apply` rechecks the local tree, validates the merged descriptor, advances the remote head only when `expected_revision_id` still matches, and updates local files only after the remote write succeeds.

The first sync creates the initial private draft and binds its exact revision. Sync does not enable skills, publish a release, or manipulate Git branches.

### Publication boundary and visibility

Local Library management, Projection, Library synchronization, and Draft synchronization are not Publication. `add`, `pull`, `enable`, `disable`, `inventory`, and Library `sync` must not upload Skill content. Author Draft synchronization may upload authored content only to private Draft storage; it does not create a Release or make that content distributable.

Only an explicit Publication operation may create a Release. Publication names an exact Draft Revision and immutable version, declares the Release visibility, and presents the exact file manifest before applying the operation. Sensitive-content checks run against that reviewed artifact. A blocking finding must be resolved explicitly rather than silently omitted or accepted.

SKIT does not infer publication intent or Release visibility from Source accessibility, repository visibility, a previous Release, or the presence of Registry credentials. A public Source may already expose its contents independently of SKIT, but recording or acquiring that Source is not SKIT Publication. A Library Entry likewise grants no Authorship, Publication, or redistribution authority.

## CLI architecture

The typed Command Catalog is the CLI's control-plane definition set. Each command declares:

- path and handler identity;
- positional arguments and flags;
- examples and summary;
- output contracts and exit codes;
- whether it may be interactive;
- stability and declared effects where applicable.

Dispatch parses against that catalog and centralizes help, successful results, structured failures, stream selection, and exit behavior. Handlers return a `CommandResult`; they do not independently choose envelope shape or write directly to output streams.

Output contracts are Valibot schemas bound to command definitions. The generated command manifest and JSON Schemas in `packages/cli/contracts/` are committed so public contract changes are visible in review. Tests check catalog invariants, generated-artifact drift, and real payload validation without adding production-time schema parsing.

## Harness knowledge and projections

Core contains a typed Harness Profile Catalog describing known roots, evidence, documentation, frontmatter behavior, and projection targets. The CLI derives supported aliases and concrete root behavior from the shared harness model rather than maintaining independent harness lists.

The catalog combines product decisions, documented behavior, and observed behavior. Those categories must remain distinguishable. A documentation URL or runtime observation is evidence for a fact; projection choice remains SKIT policy.

Catalog freshness is currently detected through verification dates. Per-fact provenance and automated freshness resolution are planned work; until then, shared verification dates should not be interpreted as independent verification of every field.

## Capability audit

The capability audit is an experimental, read-only inspection surface. Its orchestration is decomposed into adapters for filesystem I/O, provenance, skills, MCP configuration, harness-specific configuration, and executable probes.

Observations carry the harnesses and role to which they apply. Shared roots are walked once and evaluated against every declaring harness profile. Project Codex configuration is inspected only when the corresponding repository path is trusted by user configuration.

The audit reports evidence and findings; it does not mutate harness or library state.

## Stability boundaries

The repository has several different compatibility surfaces:

| Surface                                      | Current expectation                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Human CLI output                             | Intended for people; wording and layout may evolve                                            |
| Stable JSON command schemas                  | Versioned machine contract; changes require compatibility review                              |
| Experimental commands and `v1alpha1` schemas | May change before promotion                                                                   |
| Core TypeScript exports                      | Internal workspace API while packages remain private                                          |
| Registry HTTP schemas                        | Shared client/server wire contract                                                            |
| `state.json` schema                          | Authoritative local state; intentional migrations or explicit pre-release resets are required |
| Harness Profile Catalog                      | Versioned knowledge with evidence and freshness obligations                                   |

The packages are currently private and versioned `0.1.0`. The repository is licensed under the MIT License.

## Architectural pressure points

The current boundaries are coherent, but several files concentrate change and should be watched:

- `packages/skit/src/library/installation/install-directory.ts`: Installation state transitions and Projection transactions;
- `packages/skit/src/harnesses/catalog.ts`: a growing body of evidence-backed harness knowledge;
- `packages/cli/src/library.ts`: CLI-to-core workflow adaptation;
- `packages/cli/src/cli.ts`: command-handler orchestration.

File size alone is not a reason to split them. Extract a component when it has a stable responsibility, invariant, and test boundary of its own.

The Harness Profile Catalog has two explicit follow-ups: separate generated observations from human judgments with per-fact verification dates, then add a workflow that refreshes unchanged documentation evidence and surfaces upstream changes for review.

## Change checklist

Treat a change as architectural when it alters package ownership, authoritative state, identity semantics, transaction behavior, compatibility promises, or the separation between acquisition and enablement. Such a change should include:

- updated tests at the affected boundary;
- updates to this document's current-state description;
- an ADR explaining the decision and rejected alternatives;
- regenerated CLI or wire-contract artifacts when applicable.
