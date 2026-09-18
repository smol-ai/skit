// The two CLI readers of JSON this process did not write.
//
// Both used to cast the parse result. `servers: null` survived a `typeof value === "object"`
// check and threw at the lookup below it, reaching the user as a V8 message under a generic
// code. These pin the decode outcomes and the shapes that must keep working.

import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem } from "effect";
import { skitLayer } from "@smolai/skit-core";
import { join } from "node:path";
import { resolveAuthEffect } from "../src/registry/auth.js";
import { readAuthorRemoteEffect } from "../src/workflows/author/sync.js";

const ORIGIN = "https://registry.example";
const credential = { token: "t", tokenId: "i", tokenPrefix: "p", scopes: ["library:sync"] };

const withAuth = Effect.fn("withAuth")(function* (config: string) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-auth-" });
  yield* fs.writeFileString(join(home, "auth.json"), config);
  return yield* Effect.exit(resolveAuthEffect(home));
});

const withRemote = Effect.fn("withRemote")(function* (document: string) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-remote-" });
  yield* fs.writeFileString(join(root, "skit.remote.json"), document);
  return yield* Effect.exit(readAuthorRemoteEffect(root));
});

/** The tag of the single reason in a failed exit, or how it failed instead. */
const reason = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "Success";
  const [first] = exit.cause.reasons;
  if (Cause.isDieReason(first)) return `Die(${(first.defect as Error)?.constructor?.name})`;
  return Cause.isFailReason(first) ? String((first.error as { _tag?: string })._tag) : "Interrupt";
};

describe("the credential file", () => {
  it.effect("rejects servers:null as unusable rather than dying at the lookup", () =>
    Effect.gen(function* () {
      const exit = yield* withAuth(`{"schemaVersion":1,"activeOrigin":"${ORIGIN}","servers":null}`);
      assert.strictEqual(reason(exit), "CredentialsUnusable");
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect.each([
    { why: "an unsupported schema version", config: '{"schemaVersion":2,"servers":{}}' },
    { why: "invalid JSON", config: "nope" },
    { why: "a malformed credential", config: '{"schemaVersion":1,"servers":{"a":{"token":1}}}' },
  ])("rejects $why", ({ config }) =>
    Effect.gen(function* () {
      assert.strictEqual(reason(yield* withAuth(config)), "CredentialsUnusable");
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("keeps a scope this build does not know about", () =>
    Effect.gen(function* () {
      const exit = yield* withAuth(
        JSON.stringify({
          schemaVersion: 1,
          activeOrigin: ORIGIN,
          servers: { [ORIGIN]: { ...credential, scopes: ["future:scope"] } },
        }),
      );
      assert.isTrue(Exit.isSuccess(exit));
      if (Exit.isSuccess(exit)) assert.deepStrictEqual(exit.value.scopes, ["future:scope"]);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("ignores fields it does not read", () =>
    Effect.gen(function* () {
      const exit = yield* withAuth(
        JSON.stringify({
          schemaVersion: 1,
          activeOrigin: ORIGIN,
          later: true,
          servers: { [ORIGIN]: { ...credential, later: true } },
        }),
      );
      assert.isTrue(Exit.isSuccess(exit));
      if (Exit.isSuccess(exit)) assert.strictEqual(exit.value.source, "stored");
    }).pipe(Effect.provide(skitLayer)),
  );
});

describe("Author Workspace remote metadata", () => {
  const canonical = {
    schema: "skit.remote.v1",
    origin: ORIGIN,
    namespace: "acme",
    skit: "tools",
  } as const;
  const without = (key: keyof typeof canonical) =>
    JSON.stringify(Object.fromEntries(Object.entries(canonical).filter(([k]) => k !== key)));

  it.effect("accepts a canonical document", () =>
    Effect.gen(function* () {
      const exit = yield* withRemote(JSON.stringify(canonical));
      assert.isTrue(Exit.isSuccess(exit));
      if (Exit.isSuccess(exit)) assert.deepStrictEqual({ ...exit.value }, canonical);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect.each([
    { why: "an unexpected key", document: JSON.stringify({ ...canonical, extra: 1 }) },
    { why: "a missing key", document: without("skit") },
    { why: "an unsupported schema tag", document: JSON.stringify({ ...canonical, schema: "v2" }) },
    {
      why: "a non-canonical namespace",
      document: JSON.stringify({ ...canonical, namespace: "ACME" }),
    },
    {
      why: "an insecure origin",
      document: JSON.stringify({ ...canonical, origin: "http://nope" }),
    },
    { why: "an unparseable origin", document: JSON.stringify({ ...canonical, origin: "nope" }) },
    { why: "a JSON null", document: "null" },
    { why: "invalid JSON", document: "nope" },
  ])("rejects $why as invalid metadata", ({ document }) =>
    Effect.gen(function* () {
      assert.strictEqual(reason(yield* withRemote(document)), "AuthorRemoteMetadataInvalid");
    }).pipe(Effect.provide(skitLayer)),
  );
});
