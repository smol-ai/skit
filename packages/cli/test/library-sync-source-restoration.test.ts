import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  captureSnapshotArchiveEffect,
  libraryManifestFromLocalStateEffect,
  LibraryStore,
  libraryStoreLayer,
  retainedTreePath,
  projectBindingEffect,
  skitLayer,
  SourceProcess,
  type SkitSource,
} from "@smolai/skit-core";
import { addLibrarySourceEffect } from "../src/workflows/library/add.js";
import { syncLibraryEffect } from "../src/workflows/library/library-sync.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { archiveBytes, writingTo } from "./helpers/library-home.js";
import { librarySyncServer } from "./helpers/library-sync-server.js";
import { testHttpClientLayer } from "./helpers/http-test-client.js";

const origin = "https://registry.example";
const registrySource: SkitSource = {
  type: "registry",
  namespace: "tim",
  slug: "tools",
  version: "0.1.0",
  authority: origin,
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-source-restore-" });
  const sourceRoot = join(workspace, "source");
  yield* fs.makeDirectory(join(sourceRoot, "skills", "review"), { recursive: true });
  yield* fs.makeDirectory(join(sourceRoot, "shared"));
  const files = {
    "shared/context.md": "Shared review context\n",
    "skit.json": JSON.stringify({
      slug: "tools",
      skills: [
        {
          name: "review",
          path: "skills/review",
          shared: [{ from: "shared/context.md", to: "context.md" }],
        },
      ],
    }),
    "README.md": "---\nname: tools\ndescription: Collection documentation\n---\n# Tools\n",
    ".gitignore": "local-only\n",
    "skills/.gitkeep": "",
    "skills/review/SKILL.md": "---\nname: review\ndescription: Review code.\n---\n# Review\n",
  };
  for (const [path, bytes] of Object.entries(files))
    yield* fs.writeFileString(join(sourceRoot, path), bytes);
  const server = librarySyncServer();
  let release = yield* archiveBytes(sourceRoot, join(workspace, "release.zip"));
  const http = testHttpClientLayer((request, url) =>
    Effect.sync(() =>
      url.pathname.endsWith("/download")
        ? new Response(new Uint8Array(release), { headers: { "content-type": "application/zip" } })
        : server.transport(request),
    ),
  );
  const home = join(workspace, "a");
  const freshHome = join(workspace, "b");
  const load = (home: string) =>
    Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
  const sync = () =>
    writingTo(freshHome, syncLibraryEffect({ origin, apply: true })).pipe(
      Effect.provide(registryHttpLayer(http)),
      Effect.provide(http),
    );
  const seed = (source: SkitSource) =>
    Effect.gen(function* () {
      yield* writingTo(home, addLibrarySourceEffect(source)).pipe(Effect.provide(http));
      const state = yield* load(home);
      const manifest = yield* libraryManifestFromLocalStateEffect(state);
      assert.deepStrictEqual(manifest.snapshot_digests, []);
      assert.strictEqual(
        server.respond("PUT", "/api/library/portable", { expected_revision_id: null, manifest })
          .status,
        200,
      );
      return state;
    });
  return {
    fs,
    workspace,
    sourceRoot,
    files,
    server,
    freshHome,
    load,
    seed,
    sync,
    repack: Effect.gen(function* () {
      // Source archives can be plain Skill collections; do not validate them as authored SKITs.
      const archive = join(workspace, "replacement.zip");
      if (yield* fs.exists(archive)) yield* fs.remove(archive);
      const result = yield* (yield* SourceProcess).run("zip", ["-qr", archive, "."], {
        cwd: sourceRoot,
      });
      assert.strictEqual(result.exitCode, 0);
      release = yield* fs.readFile(archive);
    }),
    root: (digest: string) => retainedTreePath(join(freshHome, "originals"), digest),
  };
});

it.effect(
  "fresh Library sync restores every declared Registry file at the exact retained digest",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const state = yield* f.seed(registrySource);
      yield* f.sync();
      assert.deepStrictEqual((yield* f.load(f.freshHome)).retained_copies, state.retained_copies);
      const digest = state.retained_copies[0]!.digest;
      assert.strictEqual((yield* captureSnapshotArchiveEffect(f.root(digest))).digest, digest);
      for (const [path, bytes] of Object.entries(f.files))
        assert.strictEqual(yield* f.fs.readFileString(join(f.root(digest), path)), bytes);
      const targetRoot = join(f.workspace, "agent-skills");
      yield* writingTo(
        f.freshHome,
        Effect.gen(function* () {
          const store = yield* LibraryStore;
          const restored = yield* store.load;
          yield* store.publish({
            ...restored,
            global_bindings: [
              {
                scope: { kind: "global" },
                entries: restored.skills.map((skill) => ({
                  kind: "skill" as const,
                  skill_id: skill.skill_id,
                })),
              },
            ],
          });
          yield* projectBindingEffect({
            target: "agents",
            root: targetRoot,
            variantsPath: join(f.freshHome, "variants"),
          });
        }),
      );
      const projected = join(targetRoot, "review");
      assert.strictEqual(
        yield* f.fs.readFileString(join(projected, "context.md")),
        f.files["shared/context.md"],
      );
      assert.strictEqual(
        yield* f.fs.readFileString(join(projected, "SKILL.md")),
        f.files["skills/review/SKILL.md"],
      );
      for (const path of ["README.md", "skit.json", ".gitignore", "skills/.gitkeep"])
        assert.isFalse(yield* f.fs.exists(join(projected, path)));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("plain Registry restore keeps the retained subset and excludes sibling files", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.remove(join(f.sourceRoot, "skit.json"));
    yield* f.repack;
    const state = yield* f.seed(registrySource);
    yield* f.sync();
    const digest = state.retained_copies[0]!.digest;
    assert.strictEqual((yield* captureSnapshotArchiveEffect(f.root(digest))).digest, digest);
    assert.isFalse(yield* f.fs.exists(join(f.root(digest), "README.md")));
    assert.isFalse(yield* f.fs.exists(join(f.root(digest), "skills/.gitkeep")));
    assert.strictEqual(
      yield* f.fs.readFileString(join(f.root(digest), "skills/review/SKILL.md")),
      f.files["skills/review/SKILL.md"],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("changed declared source bytes fail before publishing a fresh Library", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const state = yield* f.seed(registrySource);
    const remote = f.server.stored;
    yield* f.fs.writeFileString(join(f.sourceRoot, "README.md"), "Changed\n");
    yield* f.repack;
    const error = yield* f.sync().pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.SyncSourceRestoreInvalid");
    if (error._tag === "Library.SyncSourceRestoreInvalid") {
      assert.strictEqual(error.digest, state.retained_copies[0]!.digest);
      assert.include(error.detail, "source returned");
    }
    assert.isFalse(yield* f.fs.exists(join(f.freshHome, "state.json")));
    assert.deepStrictEqual(f.server.stored, remote);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a declared copy rejects a source that no longer declares a SKIT", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.seed(registrySource);
    yield* f.fs.remove(join(f.sourceRoot, "skit.json"));
    yield* f.repack;
    const error = yield* f.sync().pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.SyncSourceRestoreInvalid");
    if (error._tag === "Library.SyncSourceRestoreInvalid")
      assert.include(error.detail, "no declared Descriptor");
    assert.isFalse(yield* f.fs.exists(join(f.freshHome, "state.json")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("declared Git subpath restoration captures the resolved root at its pinned commit", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const repo = join(f.workspace, "repo");
    yield* f.fs.makeDirectory(repo);
    yield* f.fs.copy(f.sourceRoot, join(repo, "nested"));
    yield* f.fs.writeFileString(join(repo, "outside.txt"), "Outside Collection\n");
    yield* Effect.sync(() => {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
      git("init", "-q");
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
    });
    const remote = "https://example.invalid/tools.git";
    const process = yield* SourceProcess;
    const route = (args: readonly string[]) => args.map((arg) => (arg === remote ? repo : arg));
    const localGit = Layer.succeed(SourceProcess, {
      run: (command, args, options) => process.run(command, route(args), options),
      output: (command, args, options) => process.output(command, route(args), options),
    });
    const state = yield* f
      .seed({ type: "git", remote, subpath: "nested" })
      .pipe(Effect.provide(localGit));
    yield* Effect.sync(() =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-qm",
          "later",
        ],
        { cwd: repo },
      ),
    );
    yield* f.sync().pipe(Effect.provide(localGit));
    const digest = state.retained_copies[0]!.digest;
    assert.strictEqual((yield* captureSnapshotArchiveEffect(f.root(digest))).digest, digest);
    assert.strictEqual(
      yield* f.fs.readFileString(join(f.root(digest), "skit.json")),
      f.files["skit.json"],
    );
    assert.isFalse(yield* f.fs.exists(join(f.root(digest), "outside.txt")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
