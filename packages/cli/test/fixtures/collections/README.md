# Real collection regression fixtures

The regular offline suite uses small, verbatim excerpts from the immutable upstream
commits in `manifest.json`. Each excerpt keeps complete selected Skill directories,
upstream README and licenses, and relevant plugin metadata. Nothing is rewritten to
make SKIT accept it. Treat the files as test data, not instructions to execute.

| Collection | Coverage |
| --- | --- |
| swyxio/skills | Root-level Skills with agent metadata |
| asmartbear/asb-skills | Hidden `.claude/skills`, `dev-skills`, real plugin symlinks |
| NVIDIA/skills | Standalone Skill and real plugin mirror, references, scripts, evals |

The manifest records included upstream paths, each file's Git blob hash and mode,
expected Skill names/paths, excluded plugin paths, and explicit path cases. Blob
hashes and modes were verified against each pinned GitHub Git tree. Tests verify
source provenance, exact membership, preview/add agreement, and every retained
Skill file's bytes. The excerpts are about 400 KB including licenses and metadata;
full-collection coverage is separate, not implied by these excerpts.

## Fixture changes

Do not edit upstream content or replace it with synthetic Skill documents to
accommodate a failure. Diagnose the production workflow first. A refresh is a
reviewed revision change: fetch the new immutable commit, copy the selected complete
directories verbatim, verify files and symlink targets against the upstream Git
tree, then review expected membership changes. Do not generate expected membership
from SKIT discovery code. Review changes to the pins and expected results explicitly.

Formatting excludes the three excerpt directories, and `.gitattributes` disables
line-ending conversion so upstream bytes remain intact. Excerpts preserve real
symlinks and expect a filesystem that supports them (macOS/Linux).

## Complete snapshots

`full-manifest.json` retains full upstream pins, archive SHA-256 checksums, and
expected membership (99 swyx, 26 A Smart Bear, 398 NVIDIA Skills). Run:

```sh
pnpm test:collections
```

This verifies or downloads the pinned complete archives into the ignored
`node_modules/.cache/skit-collections/` directory and imports their unpacked local
sources. It needs network access on a cache miss, and adds no archives to Git. The
full tests have a separate Vitest configuration and do not run in the regular suite.
A damaged or changed archive fails checksum verification; it never silently advances
to a newer upstream revision.

To additionally exercise real GitHub acquisition at the pinned NVIDIA commit and
A Smart Bear's plugin symlink through subpath and selected-member acquisition:

```sh
SKIT_COLLECTIONS_GITHUB=1 pnpm test:collections
```

GitHub acquisition uses Git clone/fetch. The cached codeload archives are fixture
transport, not SKIT's GitHub acquisition path; archive extraction limits do not
apply to Git clone/fetch. These tests do not install plugins or execute Skill scripts.
Explicit Git directory links are resolved within the checkout before discovery;
links that escape it are rejected. Selected member paths remain stable in retention.
Discovery reads local Claude, Codex, and schema-marked portable plugin declarations.
Plugin member directories follow their manifests instead of folder-name exclusions;
ordinary directories named `plugins` remain searchable. Identical complete Skill
mirrors can share one imported member when their declarations establish an alias.
Fresh imports of different same-name plugin Skills require an explicit plugin or
Skill directory selection. Invalid unselected declarations produce diagnostics and
fall back to standalone discovery; containment escapes remain errors. A repo-root
plugin does not hide other standalone Skills. Declared SKIT collections retain
their descriptor precedence. Generated collections preserve previously retained
member paths that still exist while discovering new members; a conflicting new
candidate is held with a diagnostic rather than replacing the retained path.

No schedule or CI job is installed by these commands; they can be invoked manually
or wired into a separate integration job.

## Recorded source acquisition follow-up

Selected-directory confinement does not cover file symlinks inside a directory.
Discovery now checks resolved targets of `README.md`, `SKILL.md`, `skit.json`, and
plugin manifests before reading them. Links outside the acquired Source or selected
Git checkout are rejected. Focused hostile fixtures cover escaped discovery documents
and manifests; retained Skill artifact validation remains responsible for links inside
Skill supporting content.
