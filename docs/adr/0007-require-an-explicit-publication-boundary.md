# Require an explicit Publication boundary

SKIT separates private Library and Draft operations from Publication: acquisition, local enablement, Library synchronization, and private Draft synchronization cannot create a distributable Release. Only an explicit, reviewed publish operation may cross that boundary, and it must name the immutable version, declare visibility, present the complete Release file manifest, and pass sensitive-content checks. Publishing without `--revision` publishes the SKIT's current revision; an explicit `--revision` requires the named revision. We rejected inferring publication intent or visibility from Source accessibility, repository visibility, prior Releases, or available credentials because those signals do not demonstrate deliberate consent to distribute the reviewed artifact.

## Amendment: revision selection (2026-11-13)

The revision selection above follows [ADR-0028](0028-author-skills-through-revisions-not-drafts.md),
which makes publication read the SKIT's current revision. The behavior is pinned by
`publish lets the Registry select its current SKIT when --revision is omitted` in
[`packages/cli/test/publish.test.ts`](../../packages/cli/test/publish.test.ts).
