# Use a Collection Identity catalog

> **Superseded.** Sources are now canonicalized directly as `SourceIdentity` values. Collections
> carry stable IDs and labels; the profile catalog and derived reference strings were removed.

SKIT derives the identity of every retained Skill Collection through one ordered catalog of versioned identity profiles. Each profile owns recognition, canonical structured fields, canonical collection and Skill references, display, portability, and equality. Descriptorless collections use source-backed identities such as `github:mattpocock/skills`; only a collection with a declared SKIT identity has a `skitId`.

Previously, acquisition wrapped descriptorless content in a synthetic Descriptor whose ID was `local/imported-<hash>`. That implementation convenience escaped into Bindings, Projections, ownership markers, errors, and CLI behavior. The result was opaque, falsely implied SKIT identity, and allowed independent callers to disagree about whether a Skill was named by its source reference, synthetic ID, or bare name.

We rejected continuing to hide synthetic IDs in presentation because persisted identity would remain false and every new consumer would need alias logic. We rejected using content hashes because updates would change logical collection identity. We rejected using arbitrary display strings because they do not provide structured canonicalization or portability rules. Because this state model has not shipped, schema v1 is rewritten directly without compatibility fields or migration logic.

Source Revision and Content Digest remain separate from collection identity. Collection Identity Profiles are declarative policy; acquisition adapters may vary behind the catalog but callers receive one `CollectionIdentity` result. “Registry” is reserved for an external distribution authority.
