/* oxlint-disable skit/no-promise-wrappers -- Response.json is the native HTTP fake boundary; no application operation is wrapped. */
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { skitLayer } from "@smolai/skit-core";
import {
  InvalidRequestResponse,
  LibraryManifest,
  LibraryResponse,
  RevisionConflictResponse,
  SnapshotArchive,
  SnapshotUploadResponse,
} from "@smolai/skit-core/universal/api";
import { librarySyncServer } from "./helpers/library-sync-server.js";

// The Worker suite proves these rules on real D1 with the same fixtures.
const fixtures = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = new URL(
    "../../skit-server-effect/test/fixtures/library-sync/",
    import.meta.url,
  );
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(LibraryManifest))(
    yield* fs.readFileString(new URL("manifest.json", directory).pathname),
  );
  return {
    archive: Schema.decodeUnknownSync(Schema.fromJsonString(SnapshotArchive))(
      yield* fs.readFileString(new URL("archive.json", directory).pathname),
    ),
    manifest,
    changed: {
      ...manifest,
      collections: manifest.collections.map((item) => ({ ...item, label: "test/changed" })),
    },
  };
});

it.effect("fake rejects a stale base with the contract conflict and keeps the head", () =>
  Effect.gen(function* () {
    const { archive, manifest, changed } = yield* fixtures;
    const server = librarySyncServer();
    server.respond("POST", "/api/library/snapshots", archive);
    server.respond("PUT", "/api/library/portable", { expected_revision_id: null, manifest });
    const base = server.remote!.revision_id;
    server.respond("PUT", "/api/library/portable", {
      expected_revision_id: base,
      manifest: changed,
    });
    const before = server.stored;
    const rejected = server.respond("PUT", "/api/library/portable", {
      expected_revision_id: base,
      manifest,
    });
    assert.strictEqual(rejected.status, 409);
    assert.isTrue(
      Schema.is(RevisionConflictResponse)(yield* Effect.promise(() => rejected.json())),
    );
    assert.deepStrictEqual(server.stored, before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("fake treats a retry of the committed manifest on the new head as applied", () =>
  Effect.gen(function* () {
    const { archive, manifest, changed } = yield* fixtures;
    const server = librarySyncServer();
    server.respond("POST", "/api/library/snapshots", archive);
    server.respond("PUT", "/api/library/portable", { expected_revision_id: null, manifest });
    const base = server.remote!.revision_id;
    server.respond("PUT", "/api/library/portable", {
      expected_revision_id: base,
      manifest: changed,
    });
    const committed = server.stored;
    assert.strictEqual(
      server.respond("PUT", "/api/library/portable", {
        expected_revision_id: base,
        manifest: changed,
      }).status,
      409,
    );
    const retry = server.respond("PUT", "/api/library/portable", {
      expected_revision_id: committed.head!.revision_id,
      manifest: changed,
    });
    assert.strictEqual(retry.status, 200);
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(LibraryResponse)(yield* Effect.promise(() => retry.json())).library,
      committed.head,
    );
    assert.deepStrictEqual(server.stored, committed);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("fake rejects a manifest whose snapshot is not uploaded, then reuses uploads", () =>
  Effect.gen(function* () {
    const { archive, manifest } = yield* fixtures;
    const server = librarySyncServer();
    const missing = server.respond("PUT", "/api/library/portable", {
      expected_revision_id: null,
      manifest,
    });
    assert.strictEqual(missing.status, 400);
    assert.isTrue(Schema.is(InvalidRequestResponse)(yield* Effect.promise(() => missing.json())));
    assert.strictEqual(server.writes, 0);
    const upload = () =>
      Effect.promise(() => server.respond("POST", "/api/library/snapshots", archive).json()).pipe(
        Effect.map(Schema.decodeUnknownSync(SnapshotUploadResponse)),
      );
    assert.isFalse((yield* upload()).reused);
    const before = server.stored;
    assert.isTrue((yield* upload()).reused);
    assert.deepStrictEqual(server.stored, before);
    assert.strictEqual(
      server.respond("PUT", "/api/library/portable", { expected_revision_id: null, manifest })
        .status,
      200,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
