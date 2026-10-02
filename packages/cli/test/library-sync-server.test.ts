/* oxlint-disable skit/no-promise-wrappers -- Response.json is the native HTTP fake boundary; no application operation is wrapped. */
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { LibraryManifest, SnapshotArchive, skitLayer } from "@smolai/skit-core";
import { librarySyncCasScenarios } from "../../../test-support/library-sync-cas.mjs";
import { librarySyncServer } from "./helpers/library-sync-server.js";

for (const scenario of librarySyncCasScenarios)
  it.effect(`shared fake obeys Worker CAS scenario: ${scenario.id}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixtures = new URL(
        "../../skit-server-effect/test/fixtures/library-sync/",
        import.meta.url,
      );
      const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(LibraryManifest))(
        yield* fs.readFileString(new URL("manifest.json", fixtures).pathname),
      );
      const archive = Schema.decodeUnknownSync(Schema.fromJsonString(SnapshotArchive))(
        yield* fs.readFileString(new URL("archive.json", fixtures).pathname),
      );
      const empty = Schema.decodeUnknownSync(Schema.fromJsonString(LibraryManifest))(
        yield* fs.readFileString(new URL("empty-manifest.json", fixtures).pathname),
      );
      const server = librarySyncServer();
      const changed = {
        ...manifest,
        collections: manifest.collections.map((item) => ({ ...item, label: "changed" })),
      };
      const competing = {
        ...manifest,
        collections: manifest.collections.map((item) => ({ ...item, label: "competing" })),
      };
      let expected: string | null = null;
      if (scenario.base !== "absent")
        assert.strictEqual(server.respond("POST", "/api/library/snapshots", archive).status, 200);
      if (scenario.base === "existing") {
        assert.strictEqual(
          server.respond("PUT", "/api/library/portable", { expected_revision_id: null, manifest })
            .status,
          200,
        );
        expected = server.remote!.revision_id;
      }
      if (scenario.operation === "race") {
        const values =
          scenario.base === "absent"
            ? [empty, { ...empty, bindings: [{ scope: { kind: "global" as const }, entries: [] }] }]
            : [changed, competing];
        const responses = values.map((value) =>
          server.respond("PUT", "/api/library/portable", {
            expected_revision_id: expected,
            manifest: value,
          }),
        );
        assert.deepStrictEqual(responses.map((item) => item.status).sort(), scenario.statuses);
        assert.deepStrictEqual(
          yield* Effect.promise(() => responses.find((item) => item.status === 409)!.json()),
          scenario.conflict,
        );
        const winner = responses.findIndex((item) => item.status === 200);
        assert.deepStrictEqual(server.remote!.manifest, values[winner]);
        assert.strictEqual(server.writes, scenario.base === "existing" ? 2 : 1);
        assert.strictEqual(server.stored.revisions.at(-1)!.parent_revision_id, expected);
      } else {
        assert.strictEqual(
          server.respond("PUT", "/api/library/portable", {
            expected_revision_id: expected,
            manifest: changed,
          }).status,
          200,
        );
        const before = server.stored;
        const rejected = server.respond("PUT", "/api/library/portable", {
          expected_revision_id: expected,
          manifest: scenario.operation === "stale" ? competing : changed,
        });
        const statuses = [rejected.status];
        assert.deepStrictEqual(yield* Effect.promise(() => rejected.json()), scenario.conflict);
        assert.deepStrictEqual(server.stored, before);
        if (scenario.operation === "retry") {
          statuses.push(
            server.respond("PUT", "/api/library/portable", {
              expected_revision_id: server.remote!.revision_id,
              manifest: changed,
            }).status,
          );
          assert.deepStrictEqual(server.stored, before);
        }
        assert.deepStrictEqual(statuses, scenario.statuses);
      }
      assert.deepStrictEqual(
        server.stored.snapshots,
        scenario.base === "absent" ? [] : [[archive.digest, archive]],
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("shared fake rejects a missing snapshot and reuses repeated uploads", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const fixtures = new URL(
      "../../skit-server-effect/test/fixtures/library-sync/",
      import.meta.url,
    );
    const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(LibraryManifest))(
      yield* fs.readFileString(new URL("manifest.json", fixtures).pathname),
    );
    const archive = Schema.decodeUnknownSync(Schema.fromJsonString(SnapshotArchive))(
      yield* fs.readFileString(new URL("archive.json", fixtures).pathname),
    );
    const server = librarySyncServer();
    assert.strictEqual(
      server.respond("PUT", "/api/library/portable", { expected_revision_id: null, manifest })
        .status,
      400,
    );
    assert.strictEqual(server.writes, 0);
    assert.deepStrictEqual(server.stored.snapshots, []);
    const first = server.respond("POST", "/api/library/snapshots", archive);
    assert.deepStrictEqual(yield* Effect.promise(() => first.json()), {
      library_id: "library_test",
      snapshot_digest: archive.digest,
      reused: false,
    });
    const before = server.stored;
    const retry = server.respond("POST", "/api/library/snapshots", archive);
    assert.deepStrictEqual(yield* Effect.promise(() => retry.json()), {
      library_id: "library_test",
      snapshot_digest: archive.digest,
      reused: true,
    });
    assert.deepStrictEqual(server.stored, before);
    assert.strictEqual(
      server.respond("PUT", "/api/library/portable", { expected_revision_id: null, manifest })
        .status,
      200,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
