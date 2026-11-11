# Doctor's real skill listing

`doctor-collection.json` contains all 99 `SKILL.md` files from `swyxio/skills`
at commit `038ef3441a4c7bfff16ae3241dc1730746a69a5b`, plus each existing
`agents/openai.yaml`. Documents and native metadata are verbatim. The source is
already pinned in `test/fixtures/collections/full-manifest.json`; the archive's
SHA-256 was checked against that pin before extraction. The upstream MIT license
is retained in `doctor-collection.LICENSE`.

Names and descriptions come from each document's YAML frontmatter, and display
names come from the Codex metadata. The fixture preserves explicit-only invocation
policies. Supporting scripts, references and other upstream files are not copied;
these are document fixtures, not complete distributable Skills. Nothing in these
documents is executed.

The over-budget scenario lists this real inventory. Eight documents are imported
and enabled through the real Library; the remaining 91 are unmanaged. Seven large
managed listings can be disabled; a recent transcript read protects
`slackbot-builder`. Preview, decline and cancellation verify that all document
bytes remain unchanged. Applying cleanup verifies that the used document and all
unmanaged documents remain unchanged.

Native discovery replies and the Codex version string are simulated. The native
configuration supplies `model: gpt-6.1-sol`, with no context-window or listing-budget
override. The production estimator resolves SKIT's bundled 500,000-token model
default and applies its 2% policy, yielding a 10,000-token budget. Demand is the
production estimate from these real names, descriptions, paths and invocation
policies. It is not a live Codex capture or a measured tokenizer count.
