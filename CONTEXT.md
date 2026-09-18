# skit

SKIT acquires, retains, distributes, and materializes agent skills. Its domain model keeps four questions separate: what an artifact is, where a copy is located, how that copy was derived, and whether SKIT manages it.

```text
What is it?              Artifact
Where is this copy?      Location
Where did it come from?  Provenance
Does SKIT manage it?     Custody
```

A Locator provides access to an Artifact. Provenance explains how an Artifact Instance was derived. A Library Entry retains an Artifact. A Binding states where a Skill is wanted. A Projection materializes a Binding. Custody states whether SKIT manages that Projection.

An Author changes a Draft. A Publisher publishes a Release. A Library Owner retains Artifacts and declares Binding intent. A Skill User uses Skills through Projections consumed by Harnesses.

## Language

### Artifacts

**Skill**:
One agent capability represented by a `SKILL.md` document and its related files. A skill can exist independently or as part of a skill collection.
_Avoid_: command, prompt

**Skill Version**:
One exact state of a Skill's file tree. Skill Versions are unordered: identical file trees are the same Version even when their copies have different Sources, Collection memberships, provenance, or custody. A Content Digest labels the state under a particular hashing policy; a `version` field declared inside the Skill is metadata, not Version identity.
_Avoid_: Artifact Instance, Content Digest, Source Revision, declared version

**Skill Collection**:
One or more skills arranged in the Agent Skills filesystem format. A collection does not necessarily have a SKIT identity.
_Avoid_: repo, pack, source

**Collection Identity**:
A structured, versioned identity for one retained Skill Collection. A declared SKIT supplies one kind of collection identity; a descriptorless collection derives another from its canonical Source coordinate. Collection identity excludes Source Revision, Content Digest, credentials, and display-only aliases.
_Avoid_: Provisional SKIT ID, content hash, display name

**Collection Reference**:
The canonical readable string derived from a Collection Identity. A contained Skill reference extends its collection reference with the Skill name. Callers use references for queries and relationships but do not construct or parse them independently.
_Avoid_: opaque imported ID, Source Revision, display label

**SKIT**:
A portable Agent Skills-compatible package extended by a `skit.json` Descriptor. Agent Skills consumers can use its standard Skill layout without understanding the additional SKIT metadata.
_Avoid_: library, profile, installation

**SKIT Identity**:
The stable logical identity and Release history associated with a SKIT package by one authoritative Registry. It consists of Registry authority, Namespace, and SKIT slug; its canonical readable form is `skit://<registry-authority>/<namespace>/<skit>`. A bare `namespace/skit` is shorthand only within an explicitly selected Registry. It is distinct from any concrete copy, archive, Source, or Content Digest.
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
One device-local editable checkout in which an Author changes a SKIT. It has a stable device-local workspace identity and may participate in the local Library without becoming a local-source snapshot or Registry Release.
_Avoid_: local Collection, Library Entry, Author Repository, Draft Revision

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
One immutable, versioned snapshot associated with a SKIT. A release does not become public merely because it exists.
_Avoid_: draft, installation, publication

**Artifact**:
Concrete content that SKIT can acquire, retain, validate, publish, or materialize. Skills, skill collections, drafts, and releases can be artifacts.
_Avoid_: source, location

**Artifact Instance**:
One concrete copy of an artifact at one location. Management and provenance describe an artifact instance, not an abstract skill or SKIT.
_Avoid_: artifact identity

**Content Digest**:
A hash label computed from an artifact's content under a stated hashing policy. Matching digests are evidence of content equality under that policy; a digest does not identify logical SKIT, location, Source, or provenance.
_Avoid_: SKIT ID, Skill Version, Source Revision

### Acquisition and provenance

**Locator**:
An address or path through which SKIT can acquire or observe an artifact. A locator does not identify the artifact or explain how the current copy was produced.
_Avoid_: source, provenance, artifact

**Location**:
The resolved place at which one artifact instance exists. A location can be a filesystem path, repository revision, registry resource, or URL.
_Avoid_: identity, provenance

**Source**:
A recorded locator and acquisition policy that SKIT can use again. A source is not the acquired artifact or its complete provenance.
_Avoid_: artifact, origin, upstream

**Source Revision**:
A specific state supplied by a source, such as a Git commit. It does not replace the acquired artifact's content digest.
_Avoid_: release, content digest

**Acquisition**:
The operation that obtains an artifact through a source.
_Avoid_: installation, enablement

**Original**:
The artifact retained exactly as acquired, before normalization or other transformation.
_Avoid_: release, normalized copy

**Provenance**:
The chain of acquisitions and transformations that produced one artifact instance.
_Avoid_: location, owner, source

**Derivation**:
One provenance step that produces an output artifact instance from an input artifact instance.
_Avoid_: location, copy history

**Normalization**:
A derivation that converts an acquired original into a validated SKIT representation without changing the original.
_Avoid_: publication, acquisition

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

### Library management

**Library**:
A principal's retained SKIT packages, standalone Skills or descriptorless Agent Skills packages, and desired Binding intent. Portable Library intent is separate from device-local Projection evidence.
_Avoid_: cache, registry, harness state

**Library Entry**:
The record that associates a retained artifact with its identity, locator, provenance, and selected release. A library entry does not enable a skill.
_Avoid_: installation, projection

**Library Owner**:
The principal or team whose retained artifacts and binding intent form a library. A team-owned library has no single person as its owner.
_Avoid_: author, publisher, skill user, generic user

**Skill User**:
A principal who uses a Skill through a Projection consumed by a Harness. A Skill User need not own the Library from which the Binding and retained Artifact originated. Library ownership, device-local Projection state, and SKIT Custody are separate relationships.
_Avoid_: consumer, library owner, generic user

**Harness**:
An agent tool whose configuration can consume projected skills, such as Codex, Claude Code, OpenCode, or Devin.
_Avoid_: agent, client, host, target

**Harness Availability**:
Device-local evidence that a Harness can consume Projections on this device. Support for a Harness adapter and portable Binding intent do not establish availability.
_Avoid_: Binding, supported harness, synchronized capability

**Scope**:
The context in which a binding applies: global or repository-specific. The same skill can be bound to the same harness in multiple scopes.
_Avoid_: level, project

**Binding**:
The intent that selected skills be available to one harness at one scope. A binding does not prove that SKIT materialized the corresponding files.
_Avoid_: installation, link, projection

**Library Manifest**:
A portable declaration of library entries and bindings. It contains desired state, not device-local projection evidence.
_Avoid_: state file, backup

**Reconciliation Plan**:
The proposed changes required to make local library intent agree with a library manifest.
_Avoid_: merge, sync result

### Projection and custody

**Skill Root**:
A concrete directory in which Skill artifact instances may be discovered or materialized. A Skill Root may be native to one Harness or a compatibility location consumed by several Harnesses; its path does not itself assign ownership to any Harness.
_Avoid_: Harness, Binding, Collection

**Projection Target**:
The destination at which a Skill folder is materialized. Two Bindings selecting the same physical destination are a routing collision until reconciliation proves how that folder can be managed safely.
_Avoid_: Projection, Harness, Scope, generic location

**Projection**:
One concrete Skill folder materialized at a Projection Target. Harnesses may route to or consume a Projection, but Harness and Scope are Binding inputs rather than properties of the folder. A Projection is not itself desired state, and incidental readability does not implicitly satisfy a Binding.
_Avoid_: Harness, Scope, binding, installation, source

**Custody**:
SKIT's authority to reconcile or remove one concrete projection. Custody requires explicit ownership evidence and applies only to that copy.
_Avoid_: authorship, library membership, awareness

**Ownership Marker**:
Device-local evidence that SKIT created and has custody of a projection.
_Avoid_: provenance, authorship claim

**Managed**:
A projection for which SKIT has custody and valid ownership evidence.
_Avoid_: installed, imported, known

**Unmanaged**:
An artifact instance observed at a projection target for which SKIT has no custody. Observation does not grant custody.
_Avoid_: foreign, unknown

**Orphaned Projection**:
A Projection with a valid Ownership Marker but no matching record in the local Library ledger. The marker preserves SKIT Custody; loss of the ledger record does not make the Projection Unmanaged. Reconciliation may re-index or safely release it, but must not route it through Adoption.
_Avoid_: Unmanaged, retained Collection, unowned

**Adoption**:
The explicit transfer of an existing unmanaged artifact instance into SKIT custody.
_Avoid_: discovery, import

**Observation**:
What SKIT currently sees at a projection target. An observation does not change binding intent or grant custody.
_Avoid_: desired state

### Auditing

**Audit Snapshot**:
A point-in-time, read-only account of Harnesses, Audit Entries, and Audit Findings visible from a set of local roots. A snapshot does not change Library intent, Projection state, or Custody.
_Avoid_: inventory, reconciliation plan, desired state

**Audit Entry**:
One identified Skill, plugin, MCP server registration, rule, or marketplace recorded in an Audit Snapshot. An audit entry may relate to more than one Harness and is not evidence of SKIT Custody.
_Avoid_: Observation, Projection, generic capability

**Audit Finding**:
One audit result requiring attention or interpretation. A finding explicitly identifies its related Audit Entries when known; it is not itself an Audit Entry.
_Avoid_: Audit Entry, diagnostic row, capability

**Detected Harness**:
A Harness for which an Audit Snapshot contains direct local evidence. Support for a Harness adapter alone does not make the Harness detected.
_Avoid_: supported harness, configured adapter

**Drift**:
A difference between the expected content of a managed projection and its observed content.
_Avoid_: update available, stale

**Conflict**:
A condition in which SKIT cannot safely reconcile desired state with an observed artifact instance.
_Avoid_: drift

**Tombstone**:
A device-local record that a managed projection was intentionally removed.
_Avoid_: binding, portable intent
