import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import {
  LibraryStore,
  LibraryManifest,
  LibraryWriteRequest,
  SnapshotArchive,
  deterministicTreeHashEffect,
  inspectOwnershipMarkerEffect,
  libraryStoreLayer,
  makeMachineId,
  makeSkillVersionId,
  projectBindingEffect,
  retainObservedCollectionEffect,
  skitLayer,
  withLibraryWriter,
  type LibraryManifest as Manifest,
} from "@smolai/skit-core";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { syncLibraryEffect } from "../src/workflows/library/library-sync.js";
import { testHttpClientLayer, type TestHttpHandler } from "./helpers/http-test-client.js";

it.effect(
  "syncs independent identical updates with projected custody and a read-only preview",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-alignment-" });
      const sourcePath = join(workspace, "source");
      yield* fs.makeDirectory(sourcePath);
      yield* fs.writeFileString(join(sourcePath, "SKILL.md"), "initial bytes\n");
      let published: { library_id: string; revision_id: string; manifest: Manifest } | null = null;
      const snapshots = new Map<string, typeof SnapshotArchive.Type>();
      let writes = 0;
      const transport: TestHttpHandler = (incoming) => {
        const path = new URL(incoming.url).pathname;
        if (path.startsWith("/api/libraries/")) {
          const digest = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
          const archive = snapshots.get(digest);
          assert.ok(archive);
          return Response.json(archive);
        }
        if (path === "/api/library/portable" && incoming.method === "GET")
          return published === null
            ? Response.json({ error: "library_not_found" }, { status: 404 })
            : Response.json({ library: published });
        if (incoming.body._tag !== "Uint8Array") assert.fail("Expected an encoded JSON body");
        const payload: unknown = JSON.parse(new TextDecoder().decode(incoming.body.body));
        if (path === "/api/library/snapshots") {
          const archive = Schema.decodeUnknownSync(SnapshotArchive)(payload);
          snapshots.set(archive.digest, archive);
          return Response.json({
            library_id: "library_test",
            snapshot_digest: archive.digest,
            reused: false,
          });
        }
        if (path === "/api/library/portable" && incoming.method === "PUT") {
          const request = Schema.decodeUnknownSync(LibraryWriteRequest)(payload);
          assert.strictEqual(request.expected_revision_id, published?.revision_id ?? null);
          published = {
            library_id: "library_test",
            revision_id: `revision_${++writes}`,
            manifest: request.manifest,
          };
          return Response.json({ library: published });
        }
        assert.fail(`Unexpected request: ${incoming.method} ${path}`);
      };
      const http = registryHttpLayer(testHttpClientLayer(transport));
      const device = (name: string) => {
        const home = join(workspace, name);
        return {
          home,
          layer: libraryStoreLayer({ home }),
          root: join(workspace, `${name}-skills`),
          machineId: makeMachineId(),
        };
      };
      const a = device("a");
      const b = device("b");
      const load = (device: typeof a) =>
        Effect.flatMap(LibraryStore, (store) => store.load).pipe(Effect.provide(device.layer));
      const retain = (device: typeof a, retainedAt: string) =>
        Effect.gen(function* () {
          return yield* retainObservedCollectionEffect({
            machineId: device.machineId,
            source: { type: "github", owner: "fixture", repository: "skills" },
            input: sourcePath,
            retainedAt,
            skills: [
              {
                name: "review",
                sourcePath,
                relativePath: ".",
                observedHash: yield* deterministicTreeHashEffect(sourcePath),
              },
            ],
            observations: [],
          });
        }).pipe(withLibraryWriter, Effect.provide(device.layer));
      const project = (device: typeof a) =>
        projectBindingEffect({
          target: "agents",
          root: device.root,
          variantsPath: join(device.home, "variants"),
        }).pipe(withLibraryWriter, Effect.provide(device.layer));
      const sync = (device: typeof a, apply: boolean, takeRemote?: readonly string[]) =>
        syncLibraryEffect({
          origin: "https://registry.test",
          token: "test",
          apply,
          takeRemote,
          projection: {
            variantsPath: join(device.home, "variants"),
            rootFor: (target) => (target === "agents" ? device.root : undefined),
          },
        }).pipe(
          withLibraryWriter,
          Effect.provide(device.layer),
          Effect.provide(http),
          Effect.scoped,
        );
      const initial = yield* retain(a, "2026-01-01T00:00:00.000Z");
      const skillId = initial.skills[0]?.skill_id;
      assert.ok(skillId);
      yield* Effect.flatMap(LibraryStore, (store) =>
        Effect.flatMap(store.load, (state) =>
          store.publish({
            ...state,
            global_bindings: [
              {
                scope: { kind: "global" },
                entries: [{ kind: "skill", skill_id: skillId }],
              },
            ],
          }),
        ),
      ).pipe(withLibraryWriter, Effect.provide(a.layer));
      yield* project(a);
      assert.strictEqual((yield* sync(a, true)).status, "pushed");
      assert.strictEqual((yield* sync(b, true)).status, "pulled");
      yield* fs.writeFileString(join(sourcePath, "SKILL.md"), "updated identical bytes\n");
      yield* retain(a, "2026-01-02T00:00:00.000Z");
      yield* retain(b, "2026-01-02T00:00:01.000Z");
      yield* project(a);
      yield* project(b);
      const aBefore = yield* load(a);
      const bBefore = yield* load(b);
      const publishedId = aBefore.projections[0]?.skill_version_id;
      assert.ok(publishedId);
      assert.notStrictEqual(publishedId, bBefore.projections[0]?.skill_version_id);
      assert.strictEqual((yield* sync(a, true)).status, "merged");
      const writesBeforePreview = writes;
      const markerBefore = yield* fs.readFileString(join(b.root, "review", ".skit-ownership.json"));
      assert.strictEqual((yield* sync(b, false)).status, "merge_ready");
      assert.strictEqual(writes, writesBeforePreview);
      assert.deepEqual(yield* load(b), bBefore);
      assert.strictEqual(
        yield* fs.readFileString(join(b.root, "review", ".skit-ownership.json")),
        markerBefore,
      );
      assert.strictEqual((yield* sync(b, true)).status, "merged");
      const bAfter = yield* load(b);
      assert.strictEqual(bAfter.projections[0]?.skill_version_id, publishedId);
      assert.strictEqual(
        bAfter.projections[0]?.projection_id,
        bBefore.projections[0]?.projection_id,
      );
      assert.strictEqual(
        bAfter.projections[0]?.expected_digest,
        bBefore.projections[0]?.expected_digest,
      );
      assert.strictEqual(bAfter.acquisitions.length, 3);
      assert.strictEqual(bAfter.retained_copies.length, 3);
      const marker = yield* inspectOwnershipMarkerEffect(join(b.root, "review"));
      assert.strictEqual(marker.kind, "valid");
      if (marker.kind === "valid") assert.strictEqual(marker.marker.skill_version_id, publishedId);
      assert.strictEqual(
        yield* fs.readFileString(join(b.root, "review", "SKILL.md")),
        "updated identical bytes\n",
      );
      assert.strictEqual((yield* sync(a, true)).status, "merged");
      assert.strictEqual((yield* sync(b, true)).status, "clean");
      assert.strictEqual((yield* sync(a, true)).status, "clean");
      assert.strictEqual(writes, writesBeforePreview + 1);
      // An equivalent handle must not hide a conflicting selection or invalidate --take-remote.
      const oldVersionId = initial.skills[0]?.versions[0]?.skill_version_id;
      assert.ok(oldVersionId);
      yield* Effect.flatMap(LibraryStore, (store) =>
        Effect.flatMap(store.load, (state) =>
          store.publish({
            ...state,
            skills: state.skills.map((skill) => ({ ...skill, local_version_id: oldVersionId })),
          }),
        ),
      ).pipe(withLibraryWriter, Effect.provide(a.layer));
      yield* project(a);
      assert.strictEqual((yield* sync(a, true)).status, "merged");
      const equivalentId = makeSkillVersionId();
      yield* Effect.flatMap(LibraryStore, (store) =>
        Effect.flatMap(store.load, (state) =>
          store.publish({
            ...state,
            skills: state.skills.map((skill) => ({
              ...skill,
              local_version_id: equivalentId,
              versions: skill.versions.map((version) =>
                version.skill_version_id === publishedId
                  ? { ...version, skill_version_id: equivalentId }
                  : version,
              ),
            })),
            projections: state.projections.map((projection) => ({
              ...projection,
              skill_version_id: equivalentId,
            })),
          }),
        ),
      ).pipe(withLibraryWriter, Effect.provide(b.layer));
      const conflicted = yield* sync(b, false);
      assert.strictEqual(conflicted.status, "conflicted");
      if (conflicted.status === "conflicted")
        assert.include(conflicted.conflicts, `skill:${skillId}`);
      assert.strictEqual((yield* sync(b, true, [`skill:${skillId}`])).status, "merged");
      const resolved = yield* load(b);
      assert.strictEqual(resolved.skills[0]?.local_version_id, oldVersionId);
      assert.strictEqual(resolved.projections[0]?.skill_version_id, oldVersionId);
      assert.strictEqual(
        yield* fs.readFileString(join(b.root, "review", "SKILL.md")),
        "initial bytes\n",
      );
      const latest = yield* Effect.sync(() => published);
      assert.ok(latest);
      yield* LibraryManifest.makeEffect(latest.manifest);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
