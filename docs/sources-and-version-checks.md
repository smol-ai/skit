# Sources, version checks, and skills.sh locks

This page distinguishes a **Source** SKIT can acquire again from a Skill Version retained in the
Library. A Source revision, a lock claim, an archive digest, and a Skill Version's content digest
answer different questions. See the [domain glossary](../CONTEXT.md) for those terms.

## Sources SKIT accepts today

`skit add` recognizes six Source types. `skit check` reacquires a saved Source and compares the
normalized Collection content with the retained content; for an unselected Git Source it also
treats a changed commit as a change. `skit update` reacquires and retains the result. These commands currently acquire the
content before deciding whether it changed; they do not use a metadata-only update check.

| Source                    | Examples                                                                               | Current acquisition and check                                                                                                                                                                                        | Cheaper signal available in principle                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SKIT Registry             | `skit://registry.example/owner/name`, `skit:owner/name`, or a selected `@version`      | Download the selected Release archive, normally `latest`; read its immutable Release version from the response and compare normalized content. An explicit version selects that version rather than tracking latest. | A Registry latest-Release version or digest endpoint could identify a candidate without downloading the archive. SKIT does not currently use such an endpoint for `check`.                                           |
| GitHub repository         | `owner/repo`, `gh:owner/repo`, GitHub URL, or a GitHub tree URL with ref/subpath       | Clone, check out the requested ref, acquire the selected tree, compare normalized content and commit. A repository commit can change while the selected Skill does not.                                              | A GitHub tree response can expose the selected Skill folder's Git tree SHA without downloading file bytes. This requires the exact upstream path. SKIT does not currently use this path for `check`.                 |
| Other Git remote          | HTTPS `.git`, SSH URL, or `git@...`, optionally with ref/subpath                       | Clone and compare acquired content and commit as above.                                                                                                                                                              | `git ls-remote` can cheaply reveal a tracking ref's commit, but that is only a repository-level signal. A per-path tree object is stronger where the remote and Git transport make it available.                     |
| Local path                | Directory or `SKILL.md` path                                                           | Read and normalize the current files; compare content. A local path has no separately fetchable upstream.                                                                                                            | Filesystem metadata can suggest a change but cannot prove a new Skill Version. Rehashing the tree proves the observed bytes changed.                                                                                 |
| HTTPS archive or document | `.zip`, `.tar`, `.tar.gz`, `.tgz`, or a direct `SKILL.md` URL                          | GET the archive or document, normalize it, and compare content. A direct `SKILL.md` URL supplies only that document, not sibling scripts or references.                                                              | `ETag` or `Last-Modified` can avoid a download when the server supports conditional requests, but they are HTTP change signals, not Skill Version identity. SKIT does not currently persist or use them for `check`. |
| Agent Skills discovery    | `https://example.com`, `wellknown:https://example.com#skills=review`, or an explicit index URL | Fetch the index, acquire selected artifacts or legacy listed files, normalize, and compare content. Verify `0.2.0` artifact digests before retaining.                                                                | A `0.2.0` index digest can identify a candidate without downloading the artifact. Legacy checking requires fetching listed files. SKIT currently reacquires content for `check`.                                     |

The syntax catalog and acquisition behavior live in
[`packages/skit/src/acquisition/sources.ts`](../packages/skit/src/acquisition/sources.ts). The
current comparison is in
[`packages/cli/src/handlers/library/check.ts`](../packages/cli/src/handlers/library/check.ts).
Bare `owner/repo` is normally GitHub shorthand; when a version is requested and no local path of
that name exists, SKIT promotes it to Registry shorthand. Use `gh:` or `skit:` to make the intended
Source explicit.

### Agent Skills `.well-known` discovery

`/.well-known/agent-skills/index.json` is a SKIT Library Source adapter. The
[draft discovery format](https://github.com/cloudflare/agent-skills-discovery-rfc/blob/main/README.md)
at schema `0.2.0` lists each Skill's artifact `url` and `digest`. The digest is
`sha256:` plus SHA-256 of the raw `SKILL.md` bytes for `type: "skill-md"`, or the raw archive
bytes for `type: "archive"`. Comparing an index digest with a previously verified artifact digest
can identify an update candidate with one index fetch. It is not a digest of the unpacked Skill
folder or SKIT's normalized tree. An older index without per-artifact digests requires fetching
content to compare. SKIT accepts the legacy `skills` file-list shape and tries
`/.well-known/skills/index.json` when the preferred index is absent. Use the explicit
`wellknown:` locator when discovery needs to be explicit. A bare HTTPS origin also selects
discovery; an HTTPS URL with a path continues to mean a direct document or archive Source.
Queries and fragments are rejected on bare origins. On an explicit `wellknown:` locator,
`#skills=` preserves a selected subset in the saved locator.

SKIT's Registry also serves routes under `/.well-known/agent-skills/`; that response advertises
SKIT API route templates, **not** the Agent Skills `index.json` discovery format.

Setup can adopt installed Skills with a resolvable skills.sh lock into a fetchable Source:
GitHub locks supply a repository and exact `skillPath` for every selected member; `.well-known`
locks supply the HTTPS discovery base URL (`sourceUrl` in project locks, `sourceBaseUrl` in global
locks) and selected Skill names. The saved Source keeps that selection. Setup copies the installed
bytes without fetching upstream and retains the original lock fields as claims. `skit check` and
`skit update` subsequently fetch the saved Source to compare or acquire upstream content. A lock
without a resolvable coordinate or exact GitHub paths does not become a Collection import; its
on-disk Skill remains a standalone setup candidate.
Selected Git Skill paths are part of the Collection identity, while the tracking ref is not; two
selections from the same repository can therefore be retained independently. The retained Source
uses the Skills actually selected. Conflicting claims about which installed name maps to an
upstream Git Skill path block adoption.

For retained Git skills.sh observations, `skit check` also evaluates each selected Skill path.
It first compares the lock hash with the current ref tip. When they differ, it searches commits
that changed that path and hashes each distinct folder tree until it finds one reproducing the
lock claim. This distinguishes an established `update-available` baseline from an unverified
claim. The result includes the baseline commit/tree and current upstream commit/tree as check
evidence; status is derived for each run. Version one does not infer missing Skill paths. Git
mirrors live beneath the machine Library cache and can be deleted without losing Library state.

## What can establish a newer Skill Version?

The cheap checks above have different precision. A **per-Skill Git tree SHA** or a **published
artifact digest** is a strong candidate signal for that selected Skill. A changed repository commit,
Registry Release, or HTTP validator may mean something changed outside the selected Skill or in
the distribution packaging. Local file hashes only describe the files already on this device; a
skills.sh lock hash only states what its writer expected. To report verified upstream bytes, SKIT
must fetch the selected member and compute the digest under the same hashing policy as the value
being compared. Failed fetches and unresolved upstream paths mean **unverifiable**, not current.

## skills.sh lock files SKIT observes

The repository pins the skills.sh CLI as `skills@1.5.26` in [`package.json`](../package.json).
These lock shapes and paths describe that pinned implementation; a future CLI version may change
them. skills.sh writes locks for **project** and **global** installations with different purposes:

| Scope   | Lock location                                                                                                  | Current lock version | SKIT setup observation                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Project | `<project-root>/skills-lock.json`                                                                              | 1                    | Reads the lock at each configured repository root. The lock is intended to travel with the project.                          |
| Global  | `$XDG_STATE_HOME/skills/.skill-lock.json` when `XDG_STATE_HOME` is set; otherwise `~/.agents/.skill-lock.json` | 3                    | Reads that location using the home and state directory supplied to setup. This is device state, not portable Library intent. |

### Legacy project lock entries

An older project lock may contain a GitHub `source` and installed-folder `computedHash` but no
`skillPath`. The pinned `skills` CLI treats entries without `skillPath` as legacy installations
that it cannot update automatically. Both old and current project locks use `version: 1`, so the
missing field, not the lock version, identifies this case.

SKIT still shows the lock and installed Skill in setup discovery. It omits that Collection from
the skills.sh import picker because it cannot identify the Skill's path inside the upstream
repository. The installed path, such as `.agents/skills/nuxt-ui/SKILL.md`, does not establish that
upstream path. For example, a `nuxt/ui` entry with only `source`, `sourceType`, and `computedHash`
is discovered but cannot be imported as a fetchable Source.

To refresh the claim, reinstall the selected Skill from its source with a current skills.sh CLI
in the project, then inspect the rewritten `skills-lock.json` entry for `skillPath` before rerunning
`skit setup`. Check any local edits before reinstalling; the installer may replace installed
files. Do not add a guessed `skillPath` to the lock: it must name the actual upstream Skill path.

skills.sh's canonical installed Skill folders normally live at
`<project-root>/.agents/skills/<name>` or `~/.agents/skills/<name>`. Other Harness targets can
contain links or copies. A lock does not by itself establish the location, custody, or provenance
of every folder with the same name. SKIT setup omits missing locks and records malformed and
unsupported locks separately; it does not treat them as valid empty locks. See
[`docs/setup.md`](setup.md) for custody decisions.

### The hashes are not interchangeable

| Value                             | Where it appears                                | Hash input and purpose                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project `computedHash`            | `skills-lock.json` Skill entry                  | SHA-256 over regular files beneath the installed Skill folder, sorted by relative path. Feed each path's UTF-8 bytes immediately followed by its file bytes, without separators or length prefixes. Recursion excludes `.git` and `node_modules` directories. Output is 64 hexadecimal characters. This is a lock **claim** about installed bytes.             |
| Global `skillFolderHash`          | `.skill-lock.json` Skill entry                  | For GitHub, usually the 40-character SHA of the upstream Git tree object at `skillPath`; it can be read from GitHub tree metadata without fetching Skill file bytes. For other source paths, skills.sh may fall back to the 64-character folder hash above or leave this field empty. It describes upstream state, not necessarily the local installed folder. |
| `wellKnownDigest`                 | skills.sh lock entry for a `.well-known` Source | For schema `0.2.0`, the index's `sha256:` digest of the raw downloaded artifact (`SKILL.md` or archive). Legacy discovery has a different computed digest over fetched files. Neither is SKIT's normalized Skill tree hash.                                                                                                                                    |
| SKIT observed tree digest         | Setup's on-disk Skill observation               | SHA-256 over normalized file paths, modes, and bytes with length framing; rendered as `sha256:<hex>`. It describes the observed folder under SKIT's tree policy.                                                                                                                                                                                               |
| SKIT retained Skill `contentHash` | Library Skill record                            | SHA-256 over the normalized files projected into that Skill, including declared shared files, paths relative to the Skill, modes, and bytes, with length framing. This may differ from the observed folder digest because the projected file set can differ.                                                                                                   |
| SKIT Collection content digest    | Release and Source comparison                   | SHA-256 over the normalized Collection file tree with paths, modes, bytes, and length framing. It is not a per-Skill hash.                                                                                                                                                                                                                                     |
| SKIT lock-file content hash       | Setup lock observation                          | SHA-256 of the raw lock **file text**. It identifies the observed lock document, not any Skill's files.                                                                                                                                                                                                                                                        |

The project hash stream is implemented by skills.sh's `computeSkillFolderHash` and mirrored in
[`computeSkillsLockCompatibleHash`](../packages/cli/src/workflows/library/setup.ts) for project
lock verification. SKIT's normalized and projected hashing policies live in
[`packages/skit/src/artifact/skit.ts`](../packages/skit/src/artifact/skit.ts) and
[`packages/skit/src/artifact/descriptor.ts`](../packages/skit/src/artifact/descriptor.ts).
For a project lock, setup can mark a matching on-disk instance `agrees` when its observed
skills.sh-compatible hash equals the claimed `computedHash`. Global lock content agreement is
normally `unverifiable` because its Git tree SHA is upstream metadata rather than a hash of that
installed folder. Equality or disagreement with any lock value does not itself establish whether
the upstream Source now has a newer Skill Version.
