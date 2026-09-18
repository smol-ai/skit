# Cloudflare testing

This document defines the mandatory testing policy for Cloudflare Worker code in this repository. It applies to `packages/skit-server-effect` and to any future package that uses Workers, D1, R2, Durable Objects, Queues, KV, or another Cloudflare runtime binding.

The purpose of these rules is to test the deployed execution model. A JavaScript object that resembles a Cloudflare binding is not an acceptable substitute for the binding.

Normative terms such as **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used deliberately.

## Supported test runtime

- Worker integration tests **MUST** use Cloudflare's current `@cloudflare/vitest-plugin` package.
- New code **MUST NOT** use the former `@cloudflare/vitest-pool-workers` package name.
- Tests **MUST** execute Worker modules in workerd through the Cloudflare Vitest integration.
- Tests **MUST** load bindings from the package's Wrangler configuration. They **MUST NOT** maintain a second hand-written binding configuration in test code.
- The plugin, Wrangler, Vitest, compatibility date, generated Worker types, and package lock **MUST** be upgraded together when their compatibility constraints require it.

Cloudflare renamed `@cloudflare/vitest-pool-workers` to `@cloudflare/vitest-plugin` in August 2026 without changing the configuration API. The [Cloudflare migration guide](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/) is the source of truth for package and configuration changes.

### `createTestHarness()`

Wrangler's `createTestHarness()` starts a real local Worker runtime and is not a binding mock. Its use is nevertheless narrower than the Vitest plugin:

- `createTestHarness()` **MAY** be used by a black-box product lifecycle test that must expose a loopback URL to a separately spawned process such as the built SKIT CLI.
- It **MUST NOT** be the default harness for focused Worker request, D1, R2, migration, or persistence tests. Those tests use `@cloudflare/vitest-plugin`.
- It **MUST NOT** be used to create a second copy of coverage that belongs in the Worker integration suite merely because the existing lifecycle test already starts a server.
- A lifecycle test using it **MUST** load the committed Wrangler configuration, apply committed D1 migrations, use plugin- or harness-managed temporary storage, bind only to loopback, and close the harness in `finally` cleanup.
- Code under test **MUST** still reach D1 and R2 through the real bindings returned by the harness. Supplying fabricated bindings to `createServer()` remains prohibited.
- The lifecycle suite **MUST** remain small and scenario-oriented. Fine-grained error matrices belong in the Vitest plugin suite.

In this repository, `createTestHarness()` is therefore appropriate for `pnpm test:e2e`, where the built CLI needs a registry URL. It is not appropriate for focused persistence tests in `packages/skit-server-effect/test`.

## No binding mocks

Tests **MUST NOT** replace Cloudflare bindings with maps, plain objects, spies, casts, or partial implementations. In particular:

- no fake `D1Database` or `D1PreparedStatement`;
- no in-memory `Map` standing in for D1;
- no fake `R2Bucket` or `R2Object`;
- no `as unknown as D1Database`, `as R2Bucket`, or equivalent assertion;
- no mocked transaction, batch, constraint, metadata, streaming, or object-storage behavior;
- no direct call to `createServer()` with fabricated bindings when the behavior under test reads or writes Cloudflare state.

A test that needs D1 or R2 **MUST** use the binding supplied by the workerd test environment. Assertions about stored state **MUST** query that D1 binding or inspect that R2 binding.

Mocking an external HTTP service is a different boundary. When a Worker test must isolate an outbound service, it **MAY** use Cloudflare's documented `@msw/cloudflare` integration. It **MUST NOT** mock the Worker runtime or its storage bindings to do so.

## Test layers

### Pure tests

A normal Vitest test **MAY** run in Node only when the subject is a pure function with no Worker global, request dispatch, or Cloudflare binding dependency. Suitable examples include:

- descriptor parsing;
- deterministic hashing inputs;
- merge planning;
- validation over explicit byte arrays;
- route-template matching extracted as a pure function.

Pure tests **MUST NOT** acquire a Cloudflare type through a cast or introduce a test-only storage abstraction merely to avoid the workerd suite. Once behavior crosses a Worker or binding boundary, it belongs in a Worker integration test.

### Worker integration tests

The Cloudflare Vitest suite **MUST** cover:

- request routing through the Worker's exported fetch handler;
- authentication and response status contracts;
- D1 reads, writes, uniqueness constraints, batches, and compare-and-swap behavior;
- R2 writes, reads, metadata, immutable-object behavior, and compensating cleanup;
- migrations and schema assumptions;
- interactions between D1 metadata and R2 objects;
- runtime-specific APIs such as Web Crypto and streams;
- rejection behavior at the public HTTP boundary.

Tests **SHOULD** make requests through the Worker binding or Cloudflare-provided request helper. Direct invocation of internal functions is reserved for pure logic and does not replace HTTP-boundary coverage.

### Product lifecycle tests

The process-level E2E suite **MUST** remain separate from Worker integration tests. It starts the real local Worker runtime and drives the built CLI as a separate process. It proves that independently built client and server contracts compose correctly.

An integration assertion does not replace the author/consumer lifecycle test, and the lifecycle test does not replace focused integration cases for conflicts, invalid archives, or storage invariants.

Live tests against a deployed Cloudflare account are optional and **MUST** be opt-in. They **MUST NOT** mutate production data unless a separately documented workflow explicitly authorizes it.

## D1 rules

- Every test database **MUST** start from the committed migrations in `packages/skit-server-effect/migrations`.
- Tests **MUST NOT** reproduce the production schema with inline `CREATE TABLE` statements.
- A migration change **MUST** include a test that starts from the preceding committed schema and applies the new migration when upgrade behavior matters.
- Tests **MUST** use unique resource identities or isolated storage so order and parallel execution cannot affect results.
- Tests **MUST NOT** depend on rows created by another test.
- State assertions **MUST** use SQL against the real test binding.
- Constraint and concurrency tests **MUST** exercise D1 itself; checking an application-level precondition alone is insufficient.
- Cleanup **SHOULD** use isolated per-test storage. When explicit cleanup is necessary, it **MUST** be scoped to the identities created by that test.

## R2 rules

- Tests **MUST** write and read through the real R2 test binding.
- Assertions **MUST** cover bytes and relevant HTTP/custom metadata when the production contract depends on them.
- D1/R2 consistency tests **MUST** inspect both bindings after success and failure.
- Object keys **MUST** use unique test identities unless the case intentionally tests immutability or collision behavior.
- Tests **MUST NOT** infer that an object was removed solely from a database result; they must query R2.

## Failure testing

Hand-written failing bindings are prohibited. Failure cases must be produced at a real boundary:

- invalid requests and archives through the Worker HTTP interface;
- stale revisions and uniqueness conflicts through real D1 state;
- missing objects by deleting the object from real R2 before reading it;
- schema failures through real constraints;
- unavailable-binding behavior through a dedicated Wrangler test configuration that omits the binding, when the production code supports that deployment state.

Provider outages that cannot be reproduced faithfully in the local runtime **MUST NOT** be represented by an invented implementation. Cover the deterministic recovery logic as a pure state transition if it can be extracted, and cover the actual outage path with an opt-in deployed-environment test when its value justifies the cost.

## Fixture policy

- Authored documents **MUST** be real files under `packages/skit-server-effect/test/fixtures`.
- README frontmatter, `SKILL.md`, example manifests, archive members, and migration inputs **MUST NOT** be embedded as multiline strings in test code.
- Valid, incomplete, malicious, and historical documents **MUST** live in separately named fixture directories.
- Tests **SHOULD** build archives from fixture trees using production archive code.
- A deliberately tampered archive **SHOULD** be derived from explicit tampered fixture files so the malicious difference is reviewable.
- Small scalar request values such as a version, token, slug, or one-line invalid header **MAY** remain inline.
- Fixture names **MUST** state intent, not implementation order: `valid`, `incomplete`, `tampered`, or `path-traversal`, rather than `fixture-1`.

Fixtures are test inputs and must be reviewed like production-facing examples. They **MUST** remain minimal, readable, and valid for the behavior they claim to represent.

## Isolation and determinism

- Tests **MUST** run without public network access unless explicitly classified as live tests.
- Time, random identifiers, and ports **MUST NOT** create ordering dependencies.
- Tests **MUST** await D1, R2, stream, and execution-context work before asserting state.
- Tests **MUST** not rely on a developer's Wrangler login, global configuration, persistent local database, or production resource ID.
- Local runtime artifacts **MUST** use temporary or plugin-managed storage and **MUST NOT** be committed.
- Parallel tests **MUST** have isolated resource identities. If the platform integration requires serial execution, the configuration must declare that constraint explicitly.

## Required coverage for registry changes

A change to draft or release persistence is incomplete until tests demonstrate, as applicable:

1. the HTTP request is accepted or rejected with the intended status;
2. the expected D1 rows exist and point to the selected immutable revision;
3. the expected R2 objects exist with correct bytes and metadata;
4. invalid descriptor/file relationships are rejected or stored with server-computed blocking diagnostics according to the draft contract;
5. stale compare-and-swap writes do not advance the draft head;
6. published archive paths, lengths, and digests exactly match the selected draft revision;
7. malformed, expanded, encrypted, duplicate-path, extra-file, missing-file, and tampered archives are rejected;
8. failed metadata commits do not leave a release visible as published;
9. exact-version downloads remain immutable and `latest` resolves according to the documented rule.

## Commands and quality gate

The normal repository test command runs pure tests and Worker integration tests that require no external account:

```sh
pnpm test
```

The product lifecycle suite runs with:

```sh
pnpm test:e2e
```

`pnpm check` **MUST** include every deterministic, account-free test. A pull request that changes Cloudflare behavior **MUST** report both `pnpm check` and `pnpm test:e2e` results until the lifecycle suite becomes part of the same gate.

## Review checklist

Before accepting a Cloudflare-related test change, verify:

- it uses `@cloudflare/vitest-plugin`, not the former package;
- workerd executes the Worker code;
- every D1/R2 interaction uses a real test binding;
- committed migrations create the database schema;
- no Cloudflare interface is satisfied with a cast or fake object;
- authored inputs are real fixture documents;
- tests assert persisted state, not only HTTP responses;
- identities and storage are isolated;
- the focused suite and product lifecycle suite both pass;
- documentation and ADRs reflect any changed runtime or persistence contract.
