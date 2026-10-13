import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { acquisitionIsSourceRestorable, librarySnapshotDigests } from "@smolai/skit-core";
import { LibraryChangedOnServer } from "../src/registry/failures.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { librarySyncApiEffect } from "../src/workflows/library/library-sync-api.js";
import { testHttpClientLayer } from "./helpers/http-test-client.js";
import { testPlatformLayer } from "./helpers/platform.js";

// The fake Registry encodes with the same contract schemas the client decodes with, which proves
// only that both sides agree. These literal bodies pin the supported wire format itself: a change
// to the contract that would stop this client reading what a deployed Registry sends fails here.

const wire = (name: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(join(import.meta.dirname, "fixtures/library-wire", name)),
  ).pipe(Effect.map(JSON.parse));

/** Run the client against one literal response, recording the request it sent. */
const exchange = <A, E>(
  response: () => Response,
  use: (api: Effect.Success<ReturnType<typeof librarySyncApiEffect>>) => Effect.Effect<A, E>,
) => {
  const sent: { method: string; path: string; body: unknown }[] = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const api = yield* librarySyncApiEffect({ origin: "https://registry.test", token: "test" });
      const result = yield* use(api);
      return { result, sent };
    }).pipe(
      Effect.provide(
        registryHttpLayer(
          testHttpClientLayer((request, url) =>
            Effect.sync(() => {
              sent.push({
                method: request.method,
                path: decodeURIComponent(url.pathname),
                body:
                  request.body._tag === "Uint8Array"
                    ? JSON.parse(new TextDecoder().decode(request.body.body))
                    : undefined,
              });
              return response();
            }),
          ),
        ),
      ),
    ),
  );
};

it.effect("decodes a literal skit.library.v7 head without loss", () =>
  Effect.gen(function* () {
    const head = yield* wire("portable-v7.json");
    const archive = yield* wire("snapshot-archive.json");
    const { result, sent } = yield* exchange(
      () => Response.json(head),
      (api) => api.read(),
    );
    assert.deepStrictEqual(sent, [
      { method: "GET", path: "/api/library/portable", body: undefined },
    ]);
    assert.deepStrictEqual(result, head.library);
    assert.ok(result);
    // The pinned Git Acquisition is restorable from its Source; the retained edit needs a snapshot.
    assert.deepStrictEqual(result.manifest.acquisitions.map(acquisitionIsSourceRestorable), [
      true,
      false,
    ]);
    assert.deepStrictEqual(librarySnapshotDigests(result.manifest), [archive.digest]);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("reads a literal library_not_found as an absent remote", () =>
  Effect.gen(function* () {
    const { result } = yield* exchange(
      () => Response.json({ error: "library_not_found" }, { status: 404 }),
      (api) => api.read(),
    );
    assert.strictEqual(result, null);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("rejects a literal skit.library.v2 head instead of reading it", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      exchange(
        () => Response.json(wire("portable-v2.json")),
        (api) => api.read(),
      ),
    );
    assert.strictEqual(failure._tag, "Library.LibraryApiInvalidResponse");
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("writes the supported request body and decodes the literal receipt", () =>
  Effect.gen(function* () {
    const head = yield* wire("portable-v7.json");
    const { result, sent } = yield* exchange(
      () => Response.json(head),
      (api) => api.write("revision_6", head.library.manifest),
    );
    assert.deepStrictEqual(sent, [
      {
        method: "PUT",
        path: "/api/library/portable",
        body: { expected_revision_id: "revision_6", manifest: head.library.manifest },
      },
    ]);
    assert.deepStrictEqual(result, head.library);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("reads a literal REVISION_CONFLICT as a Library changed on the server", () =>
  Effect.gen(function* () {
    const head = yield* wire("portable-v7.json");
    const failure = yield* Effect.flip(
      exchange(
        () => Response.json({ error: "REVISION_CONFLICT" }, { status: 409 }),
        (api) => api.write(null, head.library.manifest),
      ),
    );
    assert.instanceOf(failure, LibraryChangedOnServer);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("uploads the supported snapshot body and decodes the literal response", () =>
  Effect.gen(function* () {
    const archive = yield* wire("snapshot-archive.json");
    const uploaded = yield* wire("snapshot-upload.json");
    const { result, sent } = yield* exchange(
      () => Response.json(uploaded),
      (api) => api.upload(archive),
    );
    assert.deepStrictEqual(sent, [
      { method: "POST", path: "/api/library/snapshots", body: archive },
    ]);
    assert.deepStrictEqual(result, uploaded);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("downloads a literal snapshot archive with files, modes, directories and links", () =>
  Effect.gen(function* () {
    const archive = yield* wire("snapshot-archive.json");
    const { result, sent } = yield* exchange(
      () => Response.json(archive),
      (api) => api.download("library_wire", archive.digest),
    );
    assert.deepStrictEqual(sent, [
      {
        method: "GET",
        path: `/api/libraries/library_wire/snapshots/${archive.digest}`,
        body: undefined,
      },
    ]);
    assert.deepStrictEqual(result, archive);
  }).pipe(Effect.provide(testPlatformLayer)),
);
