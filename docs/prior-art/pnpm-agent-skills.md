# pnpm dependency-shipped agent skills

Snapshot: 2026-10-11. Research only; no SKIT implementation or Library changes.

Design question: how should SKIT coexist with package-manager-owned skills, and which discovery, approval, and reconciliation primitives should it borrow?

## Sources and scope

| Source | Snapshot | Area |
| --- | --- | --- |
| [pnpm source](https://github.com/pnpm/pnpm/tree/a793a29680c5c66c1bf84e54a07d6f37d1d43a71) | `a793a29680c5c66c1bf84e54a07d6f37d1d43a71`; latest commit dated 2026-10-10 | Rust implementation and tests; clone at `.tmp/pnpm` |
| [Official documentation](https://pnpm.io/agent-skills) | retrieved 2026-10-11; feature documented as added in v12.11.0 | Shipping, approvals, targets |
| SKIT checkout | working tree inspected 2026-10-11 | `packages/cli/src/audit/provenance.ts`, `docs/architecture.md`, ADR-0006 and ADR-0016 |

The corpus is deliberately bounded to the requested project and SKIT. pnpm represents dependency-coupled project distribution; SKIT represents retained Library content with explicit enablement and independent writable projections. Other managers were excluded from this focused study. pnpm is MIT licensed (`.tmp/pnpm/LICENSE`); copying substantial code requires retaining its notice. The clone's recent commit establishes current activity, not release availability of every inspected behavior.

## Main finding

pnpm makes package installation a skill distribution channel. Its strength is coupling instructions to installed dependency versions and sharing approval policy through repository configuration. SKIT's different strength is retaining content independently of `node_modules`, tracking custody and drift, and supporting Library intent across devices. The useful integration is recognizing pnpm ownership and offering explicit retention, rather than having both tools manage the same entry.

## Implementation evidence

Source paths below are relative to `.tmp/pnpm/pnpm/crates/` and refer to the pinned commit above.

- **Discovery is dependency driven.** `package-manager/src/agent_skills/discovery.rs::discover_skill_sources` walks direct dependencies of installed workspace importers, respecting included dependency groups. It supports isolated and hoisted layouts and uses lockfile resolutions and recorded hoisted locations. It does not broadly crawl all of `node_modules`.
- **The content convention is small.** `skill_names` finds one-level `skills/<directory>/SKILL.md` entries. pnpm checks existence, not frontmatter or declared Skill names. `probe_package` resolves skill directories and filters those outside the package. This is a directory containment check, not a full recursive audit of all supporting files.
- **Version selection is workspace wide.** `keep_highest` selects the highest registry version for an approval key before dropping sources with no skills. An installed newer version without skills therefore suppresses older skills. An absent newer installation does not suppress an installed older one. This can give one workspace project instructions for a different version from its own dependency.
- **Approval is separate from discovery.** `agent_skills.rs::sync_agent_skills` derives pending, approved, and denied sets from `AllowBuildPolicy`. Missing decisions become pending; explicit denial is neither pending nor linked. Grants live in `pnpm-workspace.yaml` permissions; pending dependency paths and linked entry paths are recorded in `node_modules/.modules.yaml` (`modules-yaml/src/lib.rs`). Official docs specify package-wide grants covering later versions.
- **Names qualify filesystem entries.** `link_entries` emits `pnpm-<package>-<directory>`, replacing package `/` with `+`, and rejects collisions. It does not rewrite `SKILL.md`, so directory qualification does not establish unique model-visible declared names.
- **Targets are project scoped.** `targets.rs` uses explicit `skills.dirs` or existing root `.* /skills` directories (without the space), plus the first matching nonempty agent environment indicator. Detection is broader than a fixed harness allowlist. Targets are canonicalized, deduplicated by physical directory, and checked for workspace containment before creation.
- **Reconciliation follows installation.** Approved desired links are derived on sync; stale recorded links are pruned, links are materialized, and a `pnpm-*` ignore rule is added. Target changes are also checked on the repeated-install path. `installed.rs` supports resync after approval. Global, dlx, deploy and engine package-manager installs disable linking through their configuration paths.
- **Ownership is pragmatic, not authenticated.** `is_occupied` permits replacing a recorded symlink, an unrecorded symlink resolving to the desired target, or a dangling symlink. `remove_link` preserves real directories, but recorded link removal does not verify the current link target. `is_link_entry` checks prefix and rejects parent components; it is not a custody proof. The documentation's blanket promise to touch only entries pnpm created is stronger than these implementation checks.
- **There is no whole-operation transaction here.** `sync_agent_skills` prunes before materialization. `materialize` preflights all desired destinations before creating links, but an occupied destination can be reported after obsolete links were pruned, and later I/O or `.gitignore` failures can leave partial filesystem changes. No runtime failure probe was performed.

Tests inspected: `package-manager/src/agent_skills/tests.rs` covers approval/denial, revocation, occupied paths, real directories replacing recorded links, dangling links, containment, hoisting, aliases, missing installations, highest-version selection, physical target deduplication, and symlinked `.gitignore` rejection. `cli/tests/suite/agent_skills.rs` covers install → pending → approve → link, revocation, environment targets, no-target errors, and repeat-install target changes. These are test-source evidence; tests were not executed.

## Comparison

| Dimension | pnpm | SKIT evidence inspected |
| --- | --- | --- |
| Primary unit | dependency approval key; skill subdirectory | retained Collection/Skill/Version and Binding intent |
| Authoritative policy | repository permissions and dependency resolution | portable Library intent; device-local custody |
| Projection | symlink into installed package | independent writable directory, ADR-0006 |
| Lifetime | installed dependency and continuing approval | retained artifact independent of original source |
| Ownership | linked-path ledger plus symlink heuristics | authenticated markers, target/content agreement, ADR-0016 |
| Mutation isolation | linked content shared with package location | projection edits become local drift |
| pnpm attribution | native | inspected audit reader falls back to generic symlink absent stronger provenance |

## What to borrow

1. **Recognize package-manager ownership first.** A pnpm provenance adapter should combine `.modules.yaml` linked paths, actual canonical target, installed package identity/version, and dependency resolution. A `pnpm-` prefix alone is weak evidence. Show “Managed by pnpm” with the package/version; preserve its entry during setup, cleanup, and disablement. This solves ambiguous symlink attribution and competing writers. Cost: compatibility with pnpm layout/version changes.
2. **Offer explicit retention without automatic takeover.** If a user wants a dependency skill in their portable Library, retain a verified snapshot and its package/version provenance through the existing retention model. Keep acquisition distinct from ownership transfer. This solves disappearance after dependency removal; cost: two distinct lifecycles that the UI must explain.
3. **Use pending/approved/denied for passive discovery.** Finding a skill should not imply enabling it. A pending item should explain who supplied it and what action enables it; explicit denials should not keep resurfacing as unresolved. This solves noisy discovery and unclear consent. Keep explicit user `add` requests distinct from passive dependency discovery rather than adding approval prompts universally.
4. **Consider dependency-aware suggestions.** Offer installed dependency skills with exact resolved versions as candidates, using direct dependency evidence rather than crawling caches. This solves finding instructions relevant to the current project. Cost: package-manager adapters and ambiguity in multi-version workspaces.
5. **Adopt the failure scenarios as compatibility fixtures.** Revocation, newer versions dropping skills, missing higher versions, hoisted copies of the wrong version, aliased packages, occupied paths, and shared physical targets are useful seams. Existing SKIT guarantees should determine expected outcomes; pnpm's outcomes are not automatically the specification.

## Attractive traps

- **Permanent approval across versions:** simple policy, but content can change under a previously approved package. If SKIT adds trust policy, distinguish supplier approval from review of a specific retained revision.
- **Highest version wins across a workspace:** deterministic, but not necessarily relevant to the project the agent is editing. Prefer importer-specific evidence or expose ambiguity.
- **Symlinks as SKIT's retention/projection model:** cheap for dependency distribution, incompatible with ADR-0006's mutation isolation and independent retained artifacts.
- **Prefix as identity or custody:** useful display information, insufficient proof of source ownership, declared-name uniqueness, or deletion authority.
- **Generalizing shallow discovery to Git Sources:** pnpm's narrow package convention does not replace SKIT's manifest-aware Collection discovery. Packages and arbitrary repositories have different ownership declarations.
- **Prune before complete preflight:** do not weaken SKIT's reconciliation/transaction guarantees to match pnpm's simpler install model.

## Reversible experiments and limits

First option: a disposable workspace fixture with `.modules.yaml`, a dependency package, and a pnpm-style link, exercising read-only attribution. Include retargeted links and false prefixes. Second: a setup story displaying a pnpm-managed skill and an explicit retain-copy action. Third: a report of dependency-provided skill candidates grouped by workspace importer and resolved version, with no enablement.

Unknowns: actual harness handling of prefixed directories versus frontmatter names; release-binary behavior; interrupted install recovery; and comprehensive compatibility across pnpm layouts. The study reads pinned source, test source, current docs, and selected SKIT files. It does not execute pnpm, install dependencies, mutate the real Library, or claim harness runtime verification.
