# Project into the shared `.agents` root and, when present, `.claude`

## Context

A Binding named a Harness, and SKIT wrote one copy per Harness into that Harness's own Skill
Root. Harnesses read each other's roots, so naming a Harness promised an isolation the
filesystem cannot provide:

| Root                        | Read by                                                |
| --------------------------- | ------------------------------------------------------ |
| `~/.agents/skills`          | Codex, OpenCode, Devin, Cursor, Pi                     |
| `~/.claude/skills`          | Claude Code, OpenCode, Cursor                          |
| `~/.config/opencode/skills` | OpenCode                                               |
| `~/.config/devin/skills`    | Devin                                                  |

Enabling a Skill for Codex made it visible to OpenCode, Devin, Cursor, and Pi. Disabling it for
OpenCode left it visible there through other roots. A Skill enabled for every Harness appeared
three times in OpenCode, and OpenCode 1.18 keeps a nondeterministic survivor. Per-Harness
invocation metadata and Version pins made those copies differ, so one Harness could load another's
policy or a stale Version. Evidence is recorded in the harness-guide registry and its
`overlapping-skill-roots` and `opencode-v2-skill-roots` research.

## Decision

A Binding records only Scope and entries: "these Skills are on, at this Scope." It names no
Harness.

SKIT materializes every Binding into fixed Projection Targets:

- `agents`: `.agents/skills` at the Binding's Scope. Always active. Its copies carry the native
  invocation metadata of every Harness that reads it and that SKIT can write: Codex, OpenCode, and
  Devin. Each lives in its own file or key, so one copy carries them all.
- `claude`: `.claude/skills` at the Binding's Scope. Active only when Claude Code is detected,
  because Claude Code does not document reading `.agents`.

SKIT no longer writes into OpenCode's or Devin's own roots. An invocation override is one policy
per Skill, rendered into each reader's native field.

Projection records name their target instead of a Harness. Version-7 state migration merges a
Scope's per-Harness Bindings into one. An invocation override survives only when every merged
Binding that enabled the Skill chose the same one. Former Codex and Claude Code Projections become
`agents` and `claude`; former OpenCode and Devin Projections become `legacy`. Reconciliation
retires a `legacy` Projection, or one at an inactive target, under the ordinary custody checks. The
portable Library moves to `skit.library.v7`, and older manifests decode by merging their Bindings.
Library synchronization merges Binding entries three-way, so devices that enable different Skills
concurrently do not conflict.

Ownership markers drop the Harness field. Version-2 and version-3 markers remain readable.

## Consequences

- Hiding a Skill from one Harness is not offered. That needs the Harness's own controls, such as
  OpenCode permission rules.
- Each Skill has at most two copies per Scope instead of four. OpenCode and Cursor still see both
  copies when Claude Code is present. OpenCode 2.x prefers `.agents`; 1.x may load either.
- Copies in the shared root lose ADR-0006's per-Harness drift isolation: an edit is visible to
  every reader. ADR-0006's separate-copies rule still holds between targets.
- Setup still observes OpenCode and Devin roots, but taking custody of a copy there creates the
  managed copy in `.agents`. The original remains unmanaged until its owner removes it.
- An existing foreign copy at the other target's destination is reported as conflicted instead of
  being silently ignored.
- This supersedes ADR-0008's Harness-scoped deferral and ADR-0017's per-Harness routing. Routing
  collisions between Scopes that share a physical destination remain refused.
- Whether Claude Code reads `.agents/skills` is unverified. If it does, the `claude` target can be
  removed without changing Binding intent.
