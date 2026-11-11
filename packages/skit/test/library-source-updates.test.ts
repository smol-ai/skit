import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import * as Library from "../src/library/library.js";
import { updateSources } from "../src/library/internal/session/update-sources.js";
import { skitLayer } from "../src/platform/layer.js";

for (const concurrent of ["update", "remove"] as const)
  it.effect(`source updates revalidate a concurrent ${concurrent} after taking the writer`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-update-writer-" });
      const home = join(root, "home");
      const source = join(root, "source");
      yield* fs.makeDirectory(join(source, "review"), { recursive: true });
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const importVersion = (body: string) =>
          Effect.gen(function* () {
            const path = join(source, "review");
            yield* fs.writeFileString(
              join(path, "SKILL.md"),
              `---\nname: review\ndescription: Review\n---\n${body}\n`,
            );
            return yield* library.import.collection({
              input: source,
              source: { type: "archive", url: "https://example.test/skills.tar" },
              importedAt: "2026-11-11T00:00:00Z",
              skills: [
                {
                  name: "review",
                  sourcePath: path,
                  relativePath: "review",
                  currentHash: yield* deterministicTreeHash(path),
                },
              ],
              lockFileEntries: [],
            });
          });
        const first = yield* importVersion("first");
        const selected = yield* library.read;
        const second = concurrent === "update" ? yield* importVersion("second") : undefined;
        if (concurrent === "remove")
          yield* library.remove({ query: first.collection.collection_id, dryRun: false });
        let imports = 0;
        let reads = 0;
        const outcome = yield* updateSources(
          home,
          {
            ...library,
            read: Effect.suspend(() => (reads++ === 0 ? Effect.succeed(selected) : library.read)),
          },
          first.collection.collection_id,
          {
            updateAuthoredSkills: () => Effect.die("Not an authored source"),
            progress: { around: (_stage, operation) => operation },
            importSource: () => {
              imports++;
              return Effect.succeed({
                snapshot_digest: second!.snapshotDigest,
                collection_version_id: second!.collectionVersionId,
              });
            },
          },
        ).pipe(Effect.result);
        if (concurrent === "remove") {
          assert.strictEqual(outcome._tag, "Failure");
          assert.strictEqual(imports, 0);
        } else {
          assert.strictEqual(outcome._tag, "Success");
          if (outcome._tag !== "Success") return;
          const item = outcome.success[0]!;
          assert.isTrue("changed" in item, JSON.stringify(item));
          if (!("changed" in item)) return;
          assert.strictEqual(item.previous_collection_version_id, second!.collectionVersionId);
          assert.strictEqual(item.changed, false);
        }
      }).pipe(
        Effect.provide(
          Library.layer({
            home,
            roots: { home: root, configHome: join(root, "config"), overrides: {} },
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
  );
