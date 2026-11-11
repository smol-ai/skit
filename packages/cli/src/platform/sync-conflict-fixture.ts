import { pinnedCollections } from "./storybook-fixtures.js";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { join } from "node:path";
import * as Library from "@smolai/skit-core/library";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import { makeMachineId } from "@smolai/skit-core/universal/consumer";
import { deterministicTreeHash } from "@smolai/skit-core/author";
import {
  LibraryNotFoundResponse,
  LibraryResponse,
  LibraryWriteRequest,
  RevisionConflictResponse,
  SnapshotArchive,
  SnapshotUploadResponse,
  type RemoteLibrary,
} from "@smolai/skit-core/api";
import { librarySyncApi } from "../library/sync/api.js";
import { registryHttpLayer } from "../registry/registry-http.js";

export const syncConflictOrigin = "https://registry.fixture";
const origin = syncConflictOrigin;

/**
 * Two devices sharing one compare-and-swap fixture Registry. Both synced swyxio/skills with cli-ux
 * enabled, then each re-imported it with a different cli-ux edit, and the laptop pushed first.
 * The desktop is left to sync against that remote Library.
 */
export const makeSyncConflictFixture = Effect.fn("Storybook.makeSyncConflictFixture")(function* (
  workspace: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const upstream = join(yield* pinnedCollections, "swyxio");

  // The fixture Registry: one head, written only on the revision a sync read.
  let head: RemoteLibrary | null = null;
  let revisions = 0;
  const snapshots = new Map<string, SnapshotArchive>();
  const transport = registryHttpLayer(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          const path = new URL(request.url).pathname;
          const body =
            request.body._tag === "Uint8Array"
              ? new TextDecoder().decode(request.body.body)
              : "null";
          let response: Response;
          if (request.method === "GET" && path === "/api/library/portable") {
            response =
              head === null
                ? Response.json(
                    yield* Schema.encodeEffect(LibraryNotFoundResponse)({
                      error: "library_not_found",
                    }),
                    { status: 404 },
                  )
                : Response.json(yield* Schema.encodeEffect(LibraryResponse)({ library: head }));
          } else if (request.method === "POST" && path === "/api/library/snapshots") {
            const archive = yield* Schema.decodeEffect(Schema.fromJsonString(SnapshotArchive))(
              body,
            );
            const reused = snapshots.has(archive.digest);
            snapshots.set(archive.digest, archive);
            response = Response.json(
              yield* Schema.encodeEffect(SnapshotUploadResponse)({
                library_id: "library_story",
                snapshot_digest: archive.digest,
                reused,
              }),
            );
          } else if (request.method === "PUT" && path === "/api/library/portable") {
            const write = yield* Schema.decodeEffect(Schema.fromJsonString(LibraryWriteRequest))(
              body,
            );
            if (write.expected_revision_id !== (head?.revision_id ?? null)) {
              response = Response.json(
                yield* Schema.encodeEffect(RevisionConflictResponse)({
                  error: "REVISION_CONFLICT",
                }),
                { status: 409 },
              );
            } else {
              head = {
                library_id: "library_story",
                revision_id: `revision_${++revisions}`,
                manifest: write.manifest,
              };
              response = Response.json(
                yield* Schema.encodeEffect(LibraryResponse)({ library: head }),
              );
            }
          } else if (request.method === "GET" && path.startsWith("/api/libraries/")) {
            const archive = snapshots.get(
              decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)),
            );
            response = archive
              ? Response.json(yield* Schema.encodeEffect(SnapshotArchive)(archive))
              : new Response(null, { status: 404 });
          } else {
            response = new Response(`Unexpected fixture request: ${request.method} ${path}`, {
              status: 501,
            });
          }
          return HttpClientResponse.fromWeb(request, response);
        }).pipe(Effect.orDie),
      ),
    ),
  );

  const device = (name: string) => {
    const home = join(workspace, name);
    return {
      machineId: makeMachineId(),
      source: join(workspace, `${name}-swyxio`),
      layer: Library.layer({
        home,
        roots: {
          home: join(workspace, `${name}-account`),
          configHome: join(workspace, `${name}-account`),
          overrides: { codex: [join(workspace, `${name}-skills`)] },
        },
      }).pipe(Layer.provideMerge(skitConfigurationLayer(home)), Layer.provideMerge(transport)),
    };
  };
  const laptop = device("laptop");
  const desktop = device("desktop");

  // Import this device's working copy of swyxio/skills, as `skit add` records a GitHub Source.
  const importSwyx = (owner: typeof laptop, importedAt: string, note: string | undefined) =>
    Effect.gen(function* () {
      yield* fs.copy(upstream, owner.source, { overwrite: true });
      if (note !== undefined) {
        const document = join(owner.source, "cli-ux", "SKILL.md");
        yield* fs.writeFileString(document, `${yield* fs.readFileString(document)}\n${note}\n`);
      }
      const library = yield* Library.Service;
      return yield* library.import.collection({
        machineId: owner.machineId,
        source: { type: "github", owner: "swyxio", repository: "skills" },
        input: owner.source,
        importedAt,
        skills: yield* Effect.forEach(["cli-ux", "skill-cutter"], (skill) =>
          Effect.map(deterministicTreeHash(join(owner.source, skill)), (currentHash) => ({
            name: skill,
            sourcePath: join(owner.source, skill),
            relativePath: skill,
            currentHash,
          })),
        ),
        lockFileEntries: [],
      });
    }).pipe(Effect.provide(owner.layer));
  const quietSync = (owner: typeof laptop) =>
    Effect.scoped(
      Effect.flatMap(librarySyncApi({ origin, token: "fixture" }), (api) =>
        Effect.flatMap(Library.Service, (library) =>
          library.sync({ origin, token: "fixture", apply: true }, api),
        ),
      ),
    ).pipe(Effect.provide(owner.layer));

  // Both devices share swyxio/skills with cli-ux enabled, then each edits cli-ux on its own.
  const imported = yield* importSwyx(laptop, "2026-01-01T00:00:00.000Z", undefined);
  const cliUx = imported.skills.find((skill) => skill.name === "cli-ux");
  if (!cliUx) return yield* Effect.die("Expected swyxio/skills to contain cli-ux");
  yield* Effect.gen(function* () {
    const library = yield* Library.Service;
    const plan = yield* library.plan(
      {
        _tag: "Enabled",
        changes: [
          {
            _tag: "Enable",
            subject: { _tag: "Skill", id: cliUx.skill_id },
            where: [{ kind: "global" }],
          },
        ],
      },
      { base: yield* library.read },
    );
    yield* library.apply({ _tag: "Apply", plan });
  }).pipe(Effect.provide(laptop.layer));
  yield* quietSync(laptop);
  yield* quietSync(desktop);
  yield* importSwyx(desktop, "2026-01-02T00:00:00.000Z", "Desktop: prefer --json for scripts.");
  yield* importSwyx(laptop, "2026-01-03T00:00:00.000Z", "Laptop: confirm before deleting.");
  yield* quietSync(laptop);

  return {
    /** The desktop's Library, routed as its installs, over the fixture Registry. */
    desktop: desktop.layer,
    /** Sync the desktop without rendering, as a later `skit sync --apply` would. */
    syncDesktop: quietSync(desktop),
    /** The desktop's installed cli-ux document. */
    installedCliUx: fs.readFileString(join(workspace, "desktop-skills", "cli-ux", "SKILL.md")),
  };
});
