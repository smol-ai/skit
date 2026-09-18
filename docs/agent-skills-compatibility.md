# Agent Skills compatibility

SKIT is a strict package-level extension of the [Agent Skills specification](https://agentskills.io/specification). A SKIT remains an Agent Skills-compatible package: each contained Skill uses the standard `SKILL.md` layout, and consumers that do not understand SKIT can ignore `skit.json` and use those Skills normally.

```text
Agent Skills package
        ⊂
SKIT package
```

## Agent Skills owns individual Skill metadata

Agent Skills defines an individual Skill through its directory and `SKILL.md`. Its standardized frontmatter includes the Skill's name and description, with optional fields such as license, compatibility requirements, allowed tools, and implementation-defined metadata. Related scripts, references, and assets live with that Skill.

```text
skills/review/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

SKIT does not replace or reinterpret this layout. Information that describes one Skill's behavior or requirements belongs in its `SKILL.md` when Agent Skills already has a field for it.

## SKIT adds package metadata

Agent Skills does not define a root manifest for a package containing several Skills. A SKIT adds a published, machine-owned `skit.json` Descriptor at the package root.

```text
example-skills/
├── README.md
├── skit.json
└── skills/
    ├── code-review/
    │   └── SKILL.md
    └── research/
        └── SKILL.md
```

The essential SKIT extension is explicit package membership plus portable package identity and attribution:

```json
{
  "slug": "skills",
  "author": {
    "name": "Example Author",
    "sameAs": ["https://github.com/example-author"]
  },
  "sameAs": ["https://github.com/example-author/skills"],
  "skills": [
    { "name": "code-review", "path": "skills/code-review" },
    { "name": "research", "path": "skills/research" }
  ]
}
```

The Descriptor is part of every published SKIT package. It contains no credentials, local filesystem paths, Draft synchronization state, Library Bindings, Projection evidence, or device-specific Registry configuration.

## Ownership of metadata

| Concern                                                                                               | Authoritative home         |
| ----------------------------------------------------------------------------------------------------- | -------------------------- |
| Individual Skill instructions, name, description, and Agent Skills requirements                       | `SKILL.md`                 |
| SKIT package membership and portable package identity or attribution                                  | `skit.json`                |
| Principal, Namespace, authoritative SKIT Identity, grants, Drafts, Releases, and visibility           | SKIT Registry              |
| Retained SKIT packages, standalone Skills or descriptorless Agent Skills packages, and Binding intent | User Library               |
| Projection paths, Ownership Markers, Custody, drift, conflicts, and observations                      | Device-local Library state |

The same fact should not be independently authored in several layers. When `skit.json` references a contained Skill by name, validation must confirm that it agrees with the canonical name in that Skill's `SKILL.md`; the Descriptor does not become a second authority for the Skill's own metadata.

## Fields beyond Agent Skills

The legacy README-frontmatter Descriptor and the current transitional `skit.json` schema accept several fields that Agent Skills does not standardize. They do not accept exactly the same fields: “legacy” and “current” below identify where each concept appears today.

| Field                                                        | Present in                                    | Additional SKIT-era concept                             | Intended owner                                                   |
| ------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `skit: 1` or `$schema`                                       | Legacy / current                              | Descriptor schema version or canonical schema reference | SKIT package; omit `$schema` until a canonical schema URL exists |
| `id: owner/slug`                                             | Legacy; derived rather than stored in current | Registry identity claim                                 | Registry binding, not an unverified local declaration            |
| `slug`                                                       | Current                                       | Local package identity                                  | SKIT package                                                     |
| `skills[].name` and `skills[].path`                          | Both                                          | Explicit package membership                             | SKIT package; `name` must agree with `SKILL.md`                  |
| `sameAs` and `author`                                        | Current                                       | Portable package identity claims and attribution        | SKIT package                                                     |
| `registry`                                                   | Current                                       | Authoritative server relationship                       | Private author binding                                           |
| `default_enabled`                                            | Both                                          | Suggested or desired enablement                         | User Library Binding, not package identity                       |
| `shared`                                                     | Both                                          | Package files assembled into a projected Skill          | SKIT package when it cannot be expressed within the Skill layout |
| `source_updated_at`                                          | Legacy                                        | Acquisition evidence                                    | Source provenance                                                |
| `dependencies`                                               | Legacy                                        | Package-level executable, MCP, or SKIT requirements     | SKIT package only when genuinely package-wide                    |
| `compatibility.agents` and `compatibility.operating_systems` | Legacy                                        | Package-wide compatibility                              | SKIT package only when not expressible per Skill                 |
| `invocation`                                                 | Both                                          | Portable fallback for projected invocation policy       | Prefer an explicitly authored native harness field               |
| `capabilities`                                               | Both                                          | Optional author claim compared with audit evidence      | Never treat it as a permission boundary                          |

Arbitrary Agent Skills `metadata` can carry implementation-defined values, but that does not make these fields interoperable Agent Skills concepts. A SKIT-specific extension needs its own documented semantics and must not be presented as something every Agent Skills consumer understands.

## Legacy migration

Legacy packages placed the Descriptor in root `README.md` YAML frontmatter. SKIT continues to read that form during migration, but new authoring writes `skit.json` and leaves human documentation untouched.

Migration preserves the Agent Skills package boundary:

```text
before                                      after

README.md                                   README.md
├── SKIT YAML metadata                     └── human documentation
└── human documentation
                                            skit.json
skills/**/SKILL.md                          └── portable package metadata

                                            skills/**/SKILL.md
```

Migration does not split one Agent Skills package into several SKITs merely because its contained Skills have different topics or release cadences. A package is split only when its author deliberately creates separate Agent Skills-compatible package roots.

Legacy `owner/slug` metadata is evidence of a claimed Registry identity, not proof of authority. The first authenticated Draft synchronization verifies or establishes the authoritative relationship before recording it in private author state.
