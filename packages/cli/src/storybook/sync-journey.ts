import { Effect, FileSystem, Layer, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { join } from "node:path";
import {
  LibraryStore,
  captureSnapshotArchiveEffect,
  deterministicTreeHashEffect,
  libraryManifestFromLocalStateEffect,
  libraryStoreLayer,
  makeMachineId,
  retainedTreePath,
  retainObservedCollectionEffect,
  skitLayer,
  withLibraryWriter,
} from "@smolai/skit-core";
import {
  LibraryResponse,
  SnapshotArchive,
  StorageFailureResponse,
} from "@smolai/skit-core/universal/api";
import { librarySyncCommand } from "../handlers/library/sync.js";
import { result } from "../handlers/contracts.js";
import { outputContracts } from "../commands/output-contracts.js";
import { commandFailure } from "../application.js";
import { Renderer } from "../presentation/renderer.js";
import { registryHttpLayer } from "../registry/registry-http.js";

/** Run the real sync command against a fixture Registry and disposable device homes. */
export const syncJourney = (failDownload: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-story-sync-" });
      const seedHome = join(workspace, "seed");
      const machineId = makeMachineId();
      const seeded = yield* Effect.gen(function* () {
        for (const name of ["review", "testing", "docs"]) {
          const sourcePath = join(workspace, name);
          yield* fs.makeDirectory(sourcePath);
          yield* fs.writeFileString(
            join(sourcePath, "SKILL.md"),
            `# ${name}\nFixture Skill for sync preview.\n`,
          );
          yield* retainObservedCollectionEffect({
            machineId,
            source: { type: "github", owner: "fixture", repository: name },
            input: sourcePath,
            retainedAt: "2026-01-01T00:00:00.000Z",
            skills: [
              {
                name,
                sourcePath,
                relativePath: ".",
                observedHash: yield* deterministicTreeHashEffect(sourcePath),
              },
            ],
            observations: [],
          });
        }
        const store = yield* LibraryStore;
        const state = yield* store.load;
        const bound = {
          ...state,
          global_bindings: [
            {
              scope: { kind: "global" as const },
              entries: state.skills.map((skill) => ({
                kind: "skill" as const,
                skill_id: skill.skill_id,
              })),
            },
          ],
        };
        const manifest = yield* libraryManifestFromLocalStateEffect(bound);
        const archives = yield* Effect.forEach(state.retained_copies, (tree) =>
          captureSnapshotArchiveEffect(retainedTreePath(store.originalsPath, tree.digest)),
        );
        return { manifest, archives };
      }).pipe(withLibraryWriter, Effect.provide(libraryStoreLayer({ home: seedHome })));
      const remote = {
        library_id: "library_story",
        revision_id: "revision_story",
        manifest: seeded.manifest,
      };
      let downloads = 0;
      const transport = registryHttpLayer(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              const path = new URL(request.url).pathname;
              let response: Response;
              if (request.method === "GET" && path === "/api/library/portable") {
                response = Response.json(Schema.encodeSync(LibraryResponse)({ library: remote }));
              } else if (request.method === "GET" && path.startsWith("/api/libraries/")) {
                const digest = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
                const archive = seeded.archives.find((candidate) => candidate.digest === digest);
                downloads++;
                response =
                  failDownload && downloads === 2
                    ? Response.json(
                        Schema.encodeSync(StorageFailureResponse)({ error: "storage_failure" }),
                        { status: 500 },
                      )
                    : archive
                      ? Response.json(Schema.encodeSync(SnapshotArchive)(archive))
                      : new Response(null, { status: 404 });
              } else {
                response = new Response(`Unexpected fixture request: ${request.method} ${path}`, {
                  status: 501,
                });
              }
              return HttpClientResponse.fromWeb(request, response);
            }),
          ),
        ),
      );
      const home = join(workspace, "fresh-device");
      const renderer = yield* Renderer;
      const synced = yield* librarySyncCommand({
        authState: Result.succeed({
          origin: "https://registry.fixture",
          token: "fixture",
          source: "stored",
        }),
        apply: true,
        adopt: false,
        projection: {
          variantsPath: join(home, "variants"),
          rootFor: (target) => (target === "agents" ? join(workspace, "agents-skills") : undefined),
        },
      }).pipe(
        withLibraryWriter,
        Effect.provide(libraryStoreLayer({ home })),
        Effect.provide(transport),
        Effect.catchCause((cause) =>
          renderer.failure(commandFailure(cause)).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      );
      yield* renderer.result(result("librarySync", outputContracts.librarySync, synced));
      return "3 Collections · 3 Skills · enabled on the fixture device";
    }),
  ).pipe(Effect.provide(skitLayer));
