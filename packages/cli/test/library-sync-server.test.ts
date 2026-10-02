/* oxlint-disable skit/no-promise-wrappers -- Response.json is the native HTTP fake boundary; no application operation is wrapped. */
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { LibraryManifest, LibraryReceipt, SnapshotArchive, skitLayer } from "@smolai/skit-core";
import {
  librarySyncCasScenarios,
  librarySyncLabels,
} from "../../../test-support/library-sync-cas.mjs";
import { librarySyncServer } from "./helpers/library-sync-server.js";

for (const scenario of librarySyncCasScenarios)
  it.effect(`shared fake HTTP scenario: ${scenario.id}`, () =>
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
      if (scenario.uploadInitially)
        assert.strictEqual(server.respond("POST", "/api/library/snapshots", archive).status, 200);
      const values = {
        initial: manifest,
        changed: {
          ...manifest,
          collections: manifest.collections.map((item) => ({
            ...item,
            label: librarySyncLabels.changed,
          })),
        },
        competing: {
          ...manifest,
          collections: manifest.collections.map((item) => ({
            ...item,
            label: librarySyncLabels.competing,
          })),
        },
      };
      const revisions: Record<string, string | null> = { null: null };
      for (const step of scenario.steps) {
        const before = server.stored;
        const response = server.respond(
          step.method,
          step.path,
          step.archive
            ? archive
            : step.method === "PUT"
              ? {
                  expected_revision_id: revisions[step.expectedRevision!],
                  manifest: values[step.manifest!],
                }
              : undefined,
        );
        assert.strictEqual(response.status, step.status);
        if (step.discard) {
          if (response.body) yield* Effect.promise(() => response.body!.cancel());
        } else {
          const body = yield* Effect.promise(() => response.json());
          if (step.body)
            for (const [key, value] of Object.entries(step.body))
              assert.deepStrictEqual(body[key], value);
          if (step.status === 200 && step.method !== "POST") {
            const head = Schema.decodeUnknownSync(LibraryReceipt)(body.library);
            if (step.capture) revisions[step.capture] = head.revision_id;
            if (step.method === "PUT")
              assert.deepStrictEqual(head.manifest, values[step.manifest!]);
          }
        }
        if (step.noRevision) assert.strictEqual(server.writes, 0);
        if (step.unchanged) assert.deepStrictEqual(server.stored, before);
      }
      assert.strictEqual(server.writes, scenario.revisions);
      assert.deepStrictEqual(server.stored.snapshots, [[archive.digest, archive]]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
