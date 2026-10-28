# skit

SKIT adds, imports, installs and syncs agent skills. Its domain model keeps four questions separate: what an artifact is, where a copy is located, how that copy was derived, and whether SKIT owns it.

```text
What is it?              Artifact
Where is this copy?      Location
Where did it come from?  Provenance
Does SKIT own it?        Ownership
```

A Locator provides access to an Artifact. Provenance explains how an Artifact Instance was derived. An Import records a Source's files as a Collection Version in the Library. Enabling a Skill at a Scope installs it into the skills directories Harnesses read. An Ownership Marker shows that SKIT installed a folder and may change it.

An Author changes a Draft. A Publisher publishes a Release. A Library Owner imports Collections and chooses what is enabled. A Skill User uses Skills through Installed Skills that Harnesses read.

## Verbs

Each verb has one meaning. Use these and no others for Library work.

| Verb | Meaning |
| --- | --- |
| add | Put a Source into the Library. |
| import | Store a Source's files as a Collection Version. |
| enable / disable | Choose what is on at a Scope. |
| install / uninstall | Write or remove a skill folder in a skills directory. |
| update | Bring a Source, or installed skills, up to date. |
| manage | Take over an existing folder so SKIT owns it. |
| remove | Take something out; a folder goes to recovery. |
| back up | Put a file or folder into recovery. |
| restore | Put something back from recovery. |
| undo | Reverse a setup. |
| load / save | Read or write SKIT's saved state. |
| read / write | Read or write one known thing on disk. |
| scan | Walk skills directories to find what is there. Changes nothing. |
| refresh | Scan, then save what was found into the Library. |
| check | Verify without changing anything. |
| sync | Merge this device's Library with the server's. |
| plan / apply | Preview a change, then make it. |
| inspect | Show something in detail without changing it. |

_Avoid_: acquire, retain, retire, preserve, reconcile, adopt, observe, bind, project, materialize, capture, reload, and publish for anything but Releases.

## Language

### Artifacts

**Skill**:
One agent capability represented by a `SKILL.md` document and its related files. A skill can exist independently or as part of a skill collection.
_Avoid_: command, prompt

**Skill Version**:
One exact state of a Skill's file tree. Skill Versions are unordered: identical file trees are the same Version even when their copies have different Sources, Collection memberships, provenance, or ownership. A Content Hash labels the state under a particular hashing policy; a `version` field declared inside the Skill is metadata, not Version identity.
_Avoid_: Artifact Instance, Content Hash, Source Revision, declared version

**Skill Collection**:
One or more skills arranged in the Agent Skills filesystem format. A collection does not necessarily have a SKIT identity.
_Avoid_: repo, pack, source

**Collection Identity**:
A structured, versioned identity for one Skill Collection in the Library. A declared SKIT supplies one kind of collection identity; a descriptorless collection derives another from its canonical Source coordinate. Collection identity excludes Source Revision, Content Hash, credentials, and display-only aliases.
_Avoid_: Provisional SKIT ID, content hash, display name

**Collection Reference**:
The canonical readable string derived from a Collection Identity. A contained Skill reference extends its collection reference with the Skill name. Callers use references for queries and relationships but do not construct or parse them independently.
_Avoid_: opaque imported ID, Source Revision, display label

**SKIT**:
A portable Agent Skills-compatible package extended by a `skit.json` Descriptor. Agent Skills consumers can use its standard Skill layout without understanding the additional SKIT metadata.
_Avoid_: library, profile, installation

**SKIT Identity**:
The stable logical identity and Release history associated with a SKIT package by one authoritative Registry. It consists of Registry authority, Namespace, and SKIT slug; its canonical readable form is `skit://<registry-authority>/<namespace>/<skit>`. A bare `namespace/skit` is shorthand only within an explicitly selected Registry. It is distinct from any concrete copy, archive, Source, or Content Hash.
_Avoid_: Registry-relative global ID, package file, working tree, content hash

**Descriptor**:
A Skill Collection's portable, machine-owned declaration of its local identity, contained skills, and identity claims. It is stored in `skit.json`; human documentation such as `README.md`, Git remotes, credentials, and Registry locations are not part of the Descriptor.
_Avoid_: manifest, `SKIT.md`, README frontmatter, Registry account

**Identity Claim**:
A portable assertion that a URL unambiguously identifies the same SKIT, Skill Collection, person, or organization. Descriptor `sameAs` identifies the collection; nested `author.sameAs` identifies the attributed author. An identity claim can support discovery and deduplication but does not itself prove control or grant Registry authority.
_Avoid_: source, locator, Git remote, authorization proof

**Creator Attribution**:
Portable credit naming the person or organization responsible for a Skill Collection. The Descriptor represents it as `author` for ecosystem familiarity. Attribution does not make that party an authenticated Principal, Author, or Publisher.
_Avoid_: Authorship Grant, Registry account, ownership proof

**Author Repository**:
Server-managed storage for an editable Draft's history. An implementation may use a Git repository, but Authors interact with it only through SKIT authoring operations.
_Avoid_: Git remote, Registry Binding, release archive

**Author Workspace**:
One device-local editable checkout in which an Author changes a SKIT. It has a stable device-local workspace identity and may take part in the local Library without becoming a local Collection Version or a Registry Release.
_Avoid_: local Collection, Author Repository, Draft Revision

**Author Workspace Identity**:
The opaque, device-local identity of one Author Workspace. It remains stable when that checkout moves, differs between clones, and is neither portable SKIT Identity nor an absolute path.
_Avoid_: SKIT Identity, Collection Reference, Source Locator, Descriptor slug

**Draft**:
Mutable authored content associated with a SKIT. A draft can exist locally or through a remote draft service.
_Avoid_: branch, prerelease, working copy

**Draft Revision**:
One immutable state in the history of a Draft. A server may represent it internally as a Git commit.
_Avoid_: release, public Git commit

**Release**:
One immutable, versioned set of files published for a SKIT. A release does not become public merely because it exists.
_Avoid_: draft, installation, publication

**Artifact**:
Concrete content that SKIT can import, store, validate, publish, or install. Skills, skill collections, drafts, and releases can be artifacts.
_Avoid_: source, location

**Artifact Instance**:
One concrete copy of an artifact at one location. Ownership and provenance describe an artifact instance, not an abstract skill or SKIT.
_Avoid_: artifact identity

**Content Hash**:
A hash computed from an artifact's content under a stated hashing policy, written `sha256:…`. Matching hashes are evidence of content equality under that policy; a hash does not identify a logical SKIT, location, Source, or provenance.
_Avoid_: digest, SKIT ID, Skill Version, Source Revision

### Imports and provenance

**Locator**:
An address or path through which SKIT can import or read an artifact. A locator does not identify the artifact or explain how the current copy was produced.
_Avoid_: source, provenance, artifact

**Location**:
The resolved place at which one artifact instance exists. A location can be a filesystem path, repository revision, registry resource, or URL.
_Avoid_: identity, provenance

**Source**:
A recorded locator and import policy that SKIT can use again. A source is not the imported artifact or its complete provenance.
_Avoid_: artifact, origin, upstream

**Source Revision**:
A specific state supplied by a source, such as a Git commit. It does not replace the imported artifact's Content Hash.
_Avoid_: release, content hash

**Import**:
The record of obtaining a Collection's files through a Source: which Source, which Collection Version it produced, when, and any skills.sh lock file entries that vouched for it. An Import does not enable anything.
_Avoid_: acquisition, installation, enablement

**Collection Version**:
One immutable copy of a Collection's original files, stored in the Library and identified by its Content Hash. Sync uploads the Collection Versions that cannot be fetched again from a public Source.
_Avoid_: retained copy, snapshot

**Original**:
A file exactly as imported, before normalization or other transformation. Originals are kept in Collection Versions.
_Avoid_: release, normalized copy

**Provenance**:
The chain of imports and derivations that produced one artifact instance.
_Avoid_: location, owner, source

**Derivation**:
One provenance step that produces an output artifact instance from an input artifact instance.
_Avoid_: location, copy history

**Normalization**:
A derivation that converts an imported original into a validated SKIT representation without changing the original.
_Avoid_: publication, import

### Authoring

**Author**:
A principal permitted to change a specific draft. Authorship is scoped to that draft.
_Avoid_: user, publisher, owner

**Authorship Grant**:
The relationship that permits a principal to read, change, or advance a draft.
_Avoid_: account role, publication grant

### Distribution

**Registry**:
A distribution service that accepts publications and supplies releases. A registry can also provide author-draft services, but those are separate capabilities.
_Avoid_: product-specific names, forge, hub

**Publication**:
The act that makes an immutable release available through a registry. Publication does not establish original authorship.
_Avoid_: release, upload

**Publisher**:
A principal authorized to publish a release under a SKIT identity or namespace. A publisher is not necessarily the author.
_Avoid_: author, owner, user

**Publication Grant**:
The relationship that permits a principal to publish under a SKIT identity or namespace.
_Avoid_: authorship grant, account role

### The Library

**Library**:
The Collections and Skills a principal has imported, their Collection Versions and Imports, and what they have enabled where. The portable Library is separate from this device's Installed Skills.
_Avoid_: cache, registry, harness state

**Library Owner**:
The principal or team whose imported Collections and enabled lists form a Library. A team-owned Library has no single person as its owner.
_Avoid_: author, publisher, skill user, generic user

**Skill User**:
A principal who uses a Skill through an Installed Skill that a Harness reads. A Skill User need not own the Library the Skill came from. Library ownership, this device's Installed Skills, and SKIT's Ownership of folders are separate relationships.
_Avoid_: consumer, library owner, generic user

**Harness**:
An agent tool that reads installed skills, such as Codex, Claude Code, OpenCode, or Devin.
_Avoid_: agent, client, host, target

**Harness Availability**:
Device-local evidence that a Harness can read installed skills on this device. Support for a Harness adapter and what is enabled do not establish availability.
_Avoid_: enabled, supported harness, synchronized capability

**Scope**:
Where something is enabled: everywhere on this device (global), or in one repository. The same Skill can be enabled at several scopes.
_Avoid_: level, project

**Enabled**:
The list of Collections and Skills turned on at one Scope. An enabled Collection follows its Source: every current Skill in it is on. Being enabled names no Harness, because every Harness that reads a skills directory sees what is installed there, and it does not prove that SKIT installed the files.
_Avoid_: binding, installation, link

**Library Manifest**:
The portable form of the Library that sync exchanges: its Collections, Skills, Collection Versions, Imports and what is enabled everywhere. It holds what is wanted, not what this device has installed.
_Avoid_: state file, backup

**Sync Plan**:
The changes a sync would make to bring this device's Library and the server's together.
_Avoid_: reconciliation plan, merge result

### Installing and ownership

**Skills Directory**:
A directory from which Harnesses read skill folders, such as `~/.agents/skills` or `~/.claude/skills`. A skills directory may belong to one Harness or be shared by several; its path does not by itself assign ownership to any Harness.
_Avoid_: skill root, Harness, Collection

**Install Destination**:
Where SKIT installs a skill folder: the shared `.agents/skills` directory, and `.claude/skills` when Claude Code is present. Two enabled Skills that would install into the same folder are a collision until it is clear how that folder can be managed safely.
_Avoid_: projection target, Harness, Scope, generic location

**Installed Skill**:
One skill folder SKIT installed at an Install Destination. Harnesses read Installed Skills, but Harness and Scope are not properties of the folder. An Installed Skill is not itself what is wanted, and a folder that merely happens to be readable does not count as enabled.
_Avoid_: projection, Harness, Scope, binding, source

**Ownership**:
SKIT's authority to update or remove one Installed Skill. Ownership requires an Ownership Marker and applies only to that folder.
_Avoid_: custody, authorship, library membership, awareness

**Ownership Marker**:
Device-local evidence that SKIT installed, and owns, a folder.
_Avoid_: provenance, authorship claim

**Managed**:
An Installed Skill that SKIT owns, with a valid Ownership Marker.
_Avoid_: known, imported

**Unmanaged**:
A skill folder found in a skills directory that SKIT does not own. Finding a folder does not make SKIT its owner.
_Avoid_: foreign, unknown

**Orphaned Installed Skill**:
An Installed Skill with a valid Ownership Marker but no matching record in the local Library. The marker still shows SKIT's Ownership; losing the record does not make the folder Unmanaged. A refresh may record it again or release it, but must not treat it as a folder to manage.
_Avoid_: Unmanaged, unowned, orphaned projection

### Auditing

**Audit Snapshot**:
A point-in-time, read-only account of Harnesses, Audit Entries, and Audit Findings visible from a set of local directories. A snapshot does not change what is enabled, Installed Skills, or Ownership.
_Avoid_: inventory, sync plan, desired state

**Audit Entry**:
One identified Skill, plugin, MCP server registration, rule, or marketplace recorded in an Audit Snapshot. An audit entry may relate to more than one Harness and is not evidence of SKIT's Ownership.
_Avoid_: Installed Skill, generic capability

**Audit Finding**:
One audit result requiring attention or interpretation. A finding explicitly identifies its related Audit Entries when known; it is not itself an Audit Entry.
_Avoid_: Audit Entry, diagnostic row, capability

**Detected Harness**:
A Harness for which an Audit Snapshot contains direct local evidence. Support for a Harness adapter alone does not make the Harness detected.
_Avoid_: supported harness, configured adapter

**Drift**:
A difference between an Installed Skill's expected Content Hash and the hash of what is on disk.
_Avoid_: update available, stale

**Conflict**:
A condition in which SKIT cannot safely make a folder on disk match what is enabled.
_Avoid_: drift

**Tombstone**:
A device-local record that a Managed Installed Skill was intentionally removed.
_Avoid_: enabled, portable intent
