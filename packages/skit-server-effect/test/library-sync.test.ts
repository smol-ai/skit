/* oxlint-disable skit/no-promise-wrappers -- Cloudflare test fetch, D1, R2, and Response APIs are native Promise host boundaries; Effects are composed inline without mocked bindings. */
import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach } from "vitest";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  LibraryManifest,
  LibraryReceipt,
  SnapshotArchive,
} from "@smolai/skit-core/universal/consumer";
import { commitLibraryRevision, LibraryRevisionConflict } from "../src/library/library-sync.js";
import { databaseLayer } from "../src/platform/cloudflare.js";
import { layer as nativeCryptoLayer } from "../src/platform/native-crypto.js";
import {
  librarySyncCasScenarios,
  librarySyncLabels,
} from "../../../test-support/library-sync-cas.mjs";
import archiveFixture from "./fixtures/library-sync/archive.json" with { type: "json" };
import manifestFixture from "./fixtures/library-sync/manifest.json" with { type: "json" };
import emptyManifestFixture from "./fixtures/library-sync/empty-manifest.json" with { type: "json" };
import legacyFixture from "./fixtures/library-sync/legacy-v2.json" with { type: "json" };

const archive = Schema.decodeUnknownSync(SnapshotArchive)(archiveFixture);
const manifest = Schema.decodeUnknownSync(LibraryManifest)(manifestFixture);
const receipt = Schema.Struct({ library: LibraryReceipt });
const origin = "https://registry.test";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const session = Effect.fn("Test.session")(function* () {
  const headers = { "content-type": "application/json", origin, "cf-connecting-ip": "192.0.2.150" };
  const bootstrap = yield* Effect.promise(() =>
    SELF.fetch(`${origin}/api/bootstrap`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: "skit-bootstrap-test-secret-that-is-at-least-thirty-two-characters",
        username: "sync-tester",
        email: "sync@example.test",
        password: "correct horse battery staple",
      }),
    }),
  );
  expect(bootstrap.status).toBe(201);
  const signIn = yield* Effect.promise(() =>
    SELF.fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: "sync@example.test",
        password: "correct horse battery staple",
      }),
    }),
  );
  expect(signIn.status).toBe(200);
  return { ...headers, cookie: (signIn.headers.get("set-cookie") ?? "").split(";", 1)[0]! };
});

const write = (
  headers: HeadersInit,
  expected: string | null,
  value: typeof manifest,
  path = "/api/library/portable",
) =>
  Effect.promise(() =>
    SELF.fetch(`${origin}${path}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ expected_revision_id: expected, manifest: value }),
    }),
  );

const upload = Effect.fn("Test.uploadSnapshot")(function* (headers: HeadersInit) {
  const response = yield* Effect.promise(() =>
    SELF.fetch(`${origin}/api/library/snapshots`, {
      method: "POST",
      headers,
      body: JSON.stringify(archive),
    }),
  );
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(
    Schema.Struct({ library_id: Schema.String, reused: Schema.Boolean }),
  )(yield* Effect.promise(() => response.json()));
});

const stored = Effect.fn("Test.storedLibrary")(function* (libraryId: string) {
  const library = yield* Effect.promise(() =>
    env.DB.prepare("SELECT current_revision_id FROM libraries WHERE library_id = ?")
      .bind(libraryId)
      .first(),
  );
  const revisions = yield* Effect.promise(() =>
    env.DB.prepare(
      "SELECT revision_id, parent_revision_id, manifest_json FROM library_revisions WHERE library_id = ? ORDER BY rowid",
    )
      .bind(libraryId)
      .all(),
  );
  const snapshots = yield* Effect.promise(() =>
    env.DB.prepare(
      "SELECT snapshot_digest, status, size_bytes, r2_key FROM library_snapshots WHERE library_id = ? ORDER BY snapshot_digest",
    )
      .bind(libraryId)
      .all(),
  );
  const objects = yield* Effect.promise(() => env.SKIT_BLOBS.list({ prefix: `${libraryId}/` }));
  const bytes = yield* Effect.forEach(objects.objects, (item) =>
    Effect.gen(function* () {
      const object = yield* Effect.promise(() => env.SKIT_BLOBS.get(item.key));
      expect(object).not.toBeNull();
      return {
        key: item.key,
        bytes: Array.from(new Uint8Array(yield* Effect.promise(() => object!.arrayBuffer()))),
        metadata: object!.httpMetadata,
      };
    }),
  );
  return { library, revisions: revisions.results, snapshots: snapshots.results, objects: bytes };
});

const assertArchive = Effect.fn("Test.assertArchive")(function* (libraryId: string) {
  const snapshot = yield* Effect.promise(() =>
    env.DB.prepare(
      "SELECT status, size_bytes, r2_key FROM library_snapshots WHERE library_id = ? AND snapshot_digest = ?",
    )
      .bind(libraryId, archive.digest)
      .first(),
  );
  const bytes = new TextEncoder().encode(JSON.stringify(archive));
  expect(snapshot).toEqual({
    status: "ready",
    size_bytes: bytes.length,
    r2_key: `${libraryId}/${archive.digest}`,
  });
  const object = yield* Effect.promise(() => env.SKIT_BLOBS.get(`${libraryId}/${archive.digest}`));
  expect(object).not.toBeNull();
  expect(new Uint8Array(yield* Effect.promise(() => object!.arrayBuffer()))).toEqual(bytes);
  expect(object!.httpMetadata?.contentType).toBe("application/json");
});

const changed = {
  ...manifest,
  collections: manifest.collections.map((collection) => ({
    ...collection,
    label: librarySyncLabels.changed,
  })),
};
const competing = {
  ...manifest,
  collections: manifest.collections.map((collection) => ({
    ...collection,
    label: librarySyncLabels.competing,
  })),
};

describe("Library sync Worker persistence", () => {
  it.effect("smoke: competing HTTP submissions accept one writer (not proof of D1 atomicity)", () =>
    Effect.gen(function* () {
      const headers = yield* session();
      const empty = Schema.decodeUnknownSync(LibraryManifest)(emptyManifestFixture);
      const other = Schema.decodeUnknownSync(LibraryManifest)({
        ...empty,
        bindings: [{ scope: { kind: "global" }, entries: [] }],
      });
      expect(
        (yield* Effect.promise(() => env.DB.prepare("SELECT library_id FROM libraries").all()))
          .results,
      ).toEqual([]);
      const responses = yield* Effect.all(
        [write(headers, null, empty), write(headers, null, other)],
        { concurrency: "unbounded" },
      );
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const winner = Schema.decodeUnknownSync(receipt)(
        yield* Effect.promise(() => responses.find((response) => response.status === 200)!.json()),
      ).library;
      const libraries = yield* Effect.promise(() =>
        env.DB.prepare("SELECT library_id, current_revision_id FROM libraries").all(),
      );
      expect(libraries.results).toEqual([
        { library_id: winner.library_id, current_revision_id: winner.revision_id },
      ]);
      const persisted = yield* stored(winner.library_id);
      expect(persisted.revisions).toEqual([
        expect.objectContaining({
          revision_id: winner.revision_id,
          parent_revision_id: null,
          manifest_json: JSON.stringify(winner.manifest),
        }),
      ]);
      expect(winner.manifest).toEqual(responses[0].status === 200 ? empty : other);
      expect(persisted.snapshots).toEqual([]);
      expect(persisted.objects).toEqual([]);
    }),
  );

  it.effect("conditional D1 commit rejects a head advanced after the application precheck", () =>
    Effect.gen(function* () {
      const headers = yield* session();
      const { library_id } = yield* upload(headers);
      const first = yield* write(headers, null, manifest);
      const base = Schema.decodeUnknownSync(receipt)(
        yield* Effect.promise(() => first.json()),
      ).library;
      const advance = yield* write(headers, base.revision_id, changed);
      const winner = Schema.decodeUnknownSync(receipt)(
        yield* Effect.promise(() => advance.json()),
      ).library;
      yield* Effect.promise(() =>
        env.DB.prepare("UPDATE libraries SET current_revision_id = ? WHERE library_id = ?")
          .bind(base.revision_id, library_id)
          .run(),
      );
      // Reproduce the boundary after a writer passed its precheck, then a winner advanced D1.
      yield* Effect.promise(() =>
        env.DB.prepare("UPDATE libraries SET current_revision_id = ? WHERE library_id = ?")
          .bind(winner.revision_id, library_id)
          .run(),
      );
      const before = yield* stored(library_id);
      expect(
        Schema.is(LibraryRevisionConflict)(
          yield* Effect.flip(commitLibraryRevision({ library_id }, base.revision_id, competing)),
        ),
      ).toBe(true);
      expect(yield* stored(library_id)).toEqual(before);
      yield* assertArchive(library_id);
    }).pipe(Effect.provide(databaseLayer(env.DB)), Effect.provide(nativeCryptoLayer)),
  );

  for (const scenario of librarySyncCasScenarios)
    it.effect(`shared HTTP scenario: ${scenario.id}`, () =>
      Effect.gen(function* () {
        const headers = yield* session();
        let libraryId: string | undefined;
        if (scenario.uploadInitially) libraryId = (yield* upload(headers)).library_id;
        const revisions: Record<string, string | null> = { null: null };
        const values = { initial: manifest, changed, competing };
        for (const step of scenario.steps) {
          const before = step.unchanged ? yield* stored(libraryId!) : undefined;
          const response =
            step.method === "PUT"
              ? yield* write(
                  headers,
                  revisions[step.expectedRevision!]!,
                  values[step.manifest!],
                  step.path,
                )
              : yield* Effect.promise(() =>
                  SELF.fetch(`${origin}${step.path}`, {
                    method: step.method,
                    headers,
                    ...(step.archive ? { body: JSON.stringify(archive) } : {}),
                  }),
                );
          expect(response.status).toBe(step.status);
          if (step.discard) {
            if (response.body) yield* Effect.promise(() => response.body!.cancel());
          } else {
            const body = yield* Effect.promise(() => response.json());
            if (step.body) expect(body).toMatchObject(step.body);
            if (step.status === 200 && step.method !== "POST") {
              const head = Schema.decodeUnknownSync(receipt)(body).library;
              libraryId = head.library_id;
              if (step.capture) revisions[step.capture] = head.revision_id;
              if (step.method === "PUT") expect(head.manifest).toEqual(values[step.manifest!]);
            } else if (step.status === 200) {
              libraryId = Schema.decodeUnknownSync(Schema.Struct({ library_id: Schema.String }))(
                body,
              ).library_id;
            }
          }
          if (step.noRevision)
            expect(
              (yield* Effect.promise(() =>
                env.DB.prepare("SELECT revision_id FROM library_revisions").all(),
              )).results,
            ).toEqual([]);
          if (step.unchanged) expect(yield* stored(libraryId!)).toEqual(before);
        }
        expect((yield* stored(libraryId!)).revisions).toHaveLength(scenario.revisions);
        yield* assertArchive(libraryId!);
      }),
    );

  it.effect("reuses snapshot uploads and returns the immutable archive bytes through HTTP", () =>
    Effect.gen(function* () {
      const headers = yield* session();
      const first = yield* upload(headers);
      expect(first.reused).toBe(false);
      const before = yield* stored(first.library_id);
      expect(yield* upload(headers)).toEqual({ library_id: first.library_id, reused: true });
      expect(yield* stored(first.library_id)).toEqual(before);
      const download = yield* Effect.promise(() =>
        SELF.fetch(
          `${origin}/api/libraries/${first.library_id}/snapshots/${encodeURIComponent(archive.digest)}`,
          { headers },
        ),
      );
      expect(download.status).toBe(200);
      expect(
        Schema.decodeUnknownSync(SnapshotArchive)(yield* Effect.promise(() => download.json())),
      ).toEqual(archive);
      yield* assertArchive(first.library_id);
    }),
  );

  it.effect("characterizes legacy v2 PUT replacing the portable head with the same CAS base", () =>
    Effect.gen(function* () {
      const headers = yield* session();
      const { library_id } = yield* upload(headers);
      const first = yield* write(headers, null, manifest);
      const current = Schema.decodeUnknownSync(receipt)(
        yield* Effect.promise(() => first.json()),
      ).library;
      const response = yield* Effect.promise(() =>
        SELF.fetch(`${origin}/api/library`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            expected_revision_id: current.revision_id,
            manifest: legacyFixture,
          }),
        }),
      );
      expect(response.status).toBe(200);
      const legacy = Schema.decodeUnknownSync(
        Schema.Struct({
          library: Schema.Struct({ revision_id: Schema.String, manifest: Schema.Unknown }),
        }),
      )(yield* Effect.promise(() => response.json()));
      const read = yield* Effect.promise(() =>
        SELF.fetch(`${origin}/api/library/portable`, { headers }),
      );
      expect(read.status).toBe(200);
      expect(yield* Effect.promise(() => read.json())).toMatchObject({
        library: { library_id, revision_id: legacy.library.revision_id, manifest: legacyFixture },
      });
      const persisted = yield* stored(library_id);
      expect(persisted.library).toEqual({ current_revision_id: legacy.library.revision_id });
      expect(persisted.revisions).toHaveLength(2);
      expect(persisted.revisions.at(-1)).toMatchObject({
        parent_revision_id: current.revision_id,
        manifest_json: JSON.stringify(legacyFixture),
      });
      yield* assertArchive(library_id);
    }),
  );
});
