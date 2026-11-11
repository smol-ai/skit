import { sourceUpdateOutput } from "../src/library/update/output.js";
import { commandFailure } from "../src/commands/failure-classification.js";
import { result as commandResult } from "../src/commands/result.js";
import { assert, it } from "@effect/vitest";
import { Clock, Duration, Deferred, Effect, Fiber, FileSystem, Layer } from "effect";
import { HttpClient, HttpClientError } from "effect/http";
import { join } from "node:path";
import * as Library from "@smolai/skit-core/library";
import {
  authorLayer,
  initializeAuthorWorkspace,
  updateAuthorWorkspace,
} from "@smolai/skit-core/author";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import { testPlatformLayer } from "./helpers/platform.js";
import { updateAdapters } from "../src/library/update/adapters.js";
import { renderUpdate } from "../src/library/update/present.js";
import { Block } from "../src/terminal/blocks.js";
import { resultExitCode } from "../src/commands/exit-code.js";
import { RegistryHttp, registryClient } from "../src/registry/registry-http.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { authorRegistry } from "../src/registry/author-sync.js";
import { TestClock } from "effect/testing";
import { makeAuthorSyncWorld } from "../src/platform/author-sync-fixture/world.js";
import { registryCredentialLayer } from "./helpers/registry-credential.js";
import { testHttpClientLayer } from "./helpers/http-test-client.js";
import { inspectLibrarySource } from "../src/library/source.js";
import { captureDisk, assertDiskUnchanged } from "./helpers/disk-snapshot.js";
import { DatabaseSync } from "node:sqlite";

const content = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;

// A separate SQLite connection proves that the shared home writer is available.
const assertHomeWriterAvailable = (home: string) => {
  const database = new DatabaseSync(join(home, "lock.sqlite"));
  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
};

it.effect(
  "manual authored update installs valid members offline, holds exact invalid inputs, and reports backup separately",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-manual-authored-" }),
      );
      const root = join(directory, "source");
      const home = join(directory, "home");
      const agents = join(directory, "agents");
      for (const name of ["review", "explain"]) {
        yield* fs.makeDirectory(join(root, name), { recursive: true });
        yield* fs.writeFileString(join(root, name, "SKILL.md"), content(name, "Initial"));
      }
      yield* fs.writeFileString(
        join(root, "skit.json"),
        JSON.stringify({
          slug: "tools",
          skills: ["review", "explain"].map((name) => ({ name, path: name })),
        }),
      );
      const layer = Library.layer({
        home,
        roots: {
          home: directory,
          configHome: join(directory, "config"),
          overrides: { codex: [agents] },
        },
      }).pipe(
        Layer.provideMerge(authorLayer({ home })),
        Layer.provideMerge(skitConfigurationLayer(home)),
      );
      yield* Effect.gen(function* () {
        const imported = yield* initializeAuthorWorkspace(root, home);
        const library = yield* Library.Service;
        const base = yield* library.read;
        const plan = yield* library.plan(
          {
            _tag: "Enabled",
            changes: [
              {
                _tag: "Enable",
                subject: { _tag: "Collection", id: imported.entry.collection.collection_id },
                members: "whole",
                where: [{ kind: "global" }],
              },
            ],
          },
          { base },
        );
        yield* library.apply({ _tag: "Apply", plan });
        yield* fs.writeFileString(
          join(root, "skit.remote.json"),
          JSON.stringify({
            schema: "skit.remote.v1",
            origin: "https://registry.example",
            namespace: "tim",
            skit: "tools",
          }),
        );
        const initial = yield* fs.readFileString(join(agents, "review/SKILL.md"));
        yield* fs.writeFileString(
          join(root, "review/SKILL.md"),
          "---\nname: review\n---\nInvalid without description\n",
        );
        const expected = content("explain", "Valid offline edit");
        yield* fs.writeFileString(join(root, "explain/SKILL.md"), expected);
        const adapters = yield* updateAdapters;
        const disk = yield* captureDisk([root, home, agents]);
        const preview = yield* library.previewSourceUpdates(undefined, inspectLibrarySource);
        assert.strictEqual(preview.length, 1);
        assert.strictEqual(preview[0]!.changed, true);
        assert.deepStrictEqual(preview[0]!.updated, ["explain"]);
        assert.isTrue(
          preview[0]!.issues?.some((issue) => "skill" in issue && issue.skill === "review"),
        );
        assert.isUndefined(preview[0]!.available_snapshot_digest);
        yield* assertDiskUnchanged(disk);
        const elsewhere = yield* Library.Service.pipe(
          Effect.provide(
            Library.layer({
              home: join(directory, "other-home"),
              roots: { home: directory, configHome: join(directory, "config"), overrides: {} },
            }),
          ),
        );
        const outcomes = yield* library
          .update(undefined, adapters)
          .pipe(Effect.provideService(Library.Service, elsewhere));
        assert.strictEqual(outcomes.length, 1, JSON.stringify(outcomes));
        assert.isFalse("status" in outcomes[0]!, JSON.stringify(outcomes));
        assert.strictEqual((yield* elsewhere.read)._tag, "Absent");
        assert.strictEqual(yield* fs.readFileString(join(agents, "review/SKILL.md")), initial);
        assert.strictEqual(yield* fs.readFileString(join(agents, "explain/SKILL.md")), expected);
        const result = outcomes[0]!;
        assert.isFalse("status" in result);
        if ("status" in result) return assert.fail(JSON.stringify(result));
        assert.strictEqual(result.sync_status, "failed");
        assert.isDefined(result.sync_error);
        assert.deepInclude(
          renderUpdate(sourceUpdateOutput(outcomes)),
          Block.Status({ tone: "warn", text: ["Local updates complete; Registry sync failed"] }),
        );
        assert.deepInclude(
          renderUpdate(sourceUpdateOutput(outcomes)).flatMap((block) =>
            block._tag === "Group" ? block.children : [],
          ),
          Block.Group({
            title: "Registry sync failed after the local update",
            children: commandFailure(result.sync_error!).presentation,
          }),
        );
        assert.strictEqual(
          resultExitCode(commandResult("update", sourceUpdateOutput(outcomes))),
          1,
        );
        const before = yield* library.read;
        yield* library.update(undefined, adapters);
        assert.strictEqual((yield* library.read).revision, before.revision);
        assert.strictEqual(
          (yield* library.previewSourceUpdates(undefined, inspectLibrarySource))[0]!.changed,
          false,
        );
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(RegistryHttp, {
          client: Effect.succeed(
            registryClient(
              HttpClient.make((request) =>
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      cause: new Error("Registry offline"),
                    }),
                  }),
                ),
              ),
            ),
          ),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testPlatformLayer)),
);

it.effect("installation and Registry sync share removal grace while safe edits advance", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const world = yield* makeAuthorSyncWorld();
    yield* world.a.edit("skills/review/notes.txt", "Supporting input to remove");
    yield* world.connect();
    yield* world.a.registerAndEnable();
    const { home, workspace } = world.a;
    const installed = join(workspace, "..", "agents");
    const owners = Library.layer({
      home,
      roots: {
        home: join(home, "device"),
        configHome: join(home, "config"),
        overrides: { codex: [installed] },
      },
    }).pipe(
      Layer.provideMerge(authorLayer({ home })),
      Layer.provideMerge(
        registryCredentialLayer("https://registry.example").pipe(
          Layer.provideMerge(registryHttpLayer(testHttpClientLayer(world.server.transport("a")))),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const registry = authorRegistry(home);
      yield* updateAuthorWorkspace(workspace, { home }, registry);
      const before = yield* world.a.installed("review/SKILL.md");
      const edited = "---\nname: review\ndescription: Review code.\n---\n# Safe local change\n";
      yield* world.a.edit("skills/review/SKILL.md", edited);
      yield* fs.remove(join(workspace, "skills/review/notes.txt"));
      const clock = yield* Clock.Clock;
      const waiting = yield* Deferred.make<void>();
      const pending = yield* updateAuthorWorkspace(workspace, { home }, registry).pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          currentTimeMillis: clock.currentTimeMillis,
          currentTimeNanos: clock.currentTimeNanos,
          monotonicTimeNanos: clock.monotonicTimeNanos,
          sleep: (duration) =>
            (Duration.toMillis(duration) === 10_000
              ? Deferred.succeed(waiting, undefined)
              : Effect.void
            ).pipe(Effect.andThen(clock.sleep(duration))),
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(waiting);
      assert.strictEqual(yield* world.a.installed("review/SKILL.md"), before);
      assert.strictEqual(
        yield* world.a.installed("review/notes.txt"),
        "Supporting input to remove",
      );
      yield* Effect.sync(() => assertHomeWriterAvailable(home));
      yield* TestClock.adjust("10 seconds");
      const updated = yield* Fiber.join(pending);
      assert.strictEqual(updated.installation._tag, "Success");
      assert.strictEqual(updated.sync?._tag, "Success");
      if (updated.sync?._tag === "Success")
        assert.strictEqual(updated.sync.success.status, "pushed");
      assert.strictEqual(
        yield* world.a.installed("review/SKILL.md"),
        before.replace("# Review", "# Safe local change"),
      );
      assert.isFalse(yield* fs.exists(join(installed, "review/notes.txt")));
      const current = (yield* world.server.currentHistory()).at(-1)!;
      assert.isFalse(current.tree.some((entry) => entry.path === "skills/review/notes.txt"));
      const library = yield* Library.Service;
      const saved = yield* library.read;
      const versions = (yield* world.server.currentHistory()).length;
      yield* updateAuthorWorkspace(workspace, { home }, registry);
      assert.strictEqual((yield* library.read).revision, saved.revision);
      assert.strictEqual((yield* world.server.currentHistory()).length, versions);
    }).pipe(Effect.provide(owners));
  }).pipe(Effect.scoped, Effect.provide(testPlatformLayer)),
);

it.effect(
  "fresh CLI owners confirm file and member removals offline without holding the Library writer",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-manual-removal-" }),
      );
      const root = join(directory, "source");
      const home = join(directory, "home");
      const agents = join(directory, "agents");
      for (const name of ["review", "explain"]) {
        yield* fs.makeDirectory(join(root, name), { recursive: true });
        yield* fs.writeFileString(join(root, name, "SKILL.md"), content(name, "Initial"));
      }
      const config = {
        slug: "tools",
        skills: ["review", "explain"].map((name) => ({ name, path: name })),
      };
      yield* fs.writeFileString(join(root, "skit.json"), JSON.stringify(config));
      yield* fs.writeFileString(join(root, "review/notes.txt"), "Supporting input");
      const owners = Library.layer({
        home,
        roots: {
          home: directory,
          configHome: join(directory, "config"),
          overrides: { codex: [agents] },
        },
      }).pipe(Layer.provideMerge(authorLayer({ home })));
      yield* Effect.gen(function* () {
        const imported = yield* initializeAuthorWorkspace(root, home);
        const library = yield* Library.Service;
        const plan = yield* library.plan(
          {
            _tag: "Enabled",
            changes: [
              {
                _tag: "Enable",
                subject: { _tag: "Collection", id: imported.entry.collection.collection_id },
                members: "whole",
                where: [{ kind: "global" }],
              },
            ],
          },
          { base: yield* library.read },
        );
        yield* library.apply({ _tag: "Apply", plan });
        const adapters = yield* updateAdapters;
        const clock = yield* Clock.Clock;
        for (const change of ["file", "member"]) {
          if (change === "file") yield* fs.remove(join(root, "review/notes.txt"));
          else {
            config.skills = config.skills.filter((skill) => skill.name !== "review");
            yield* fs.writeFileString(join(root, "skit.json"), JSON.stringify(config));
            yield* fs.remove(join(root, "review"), { recursive: true });
          }
          const waiting = yield* Deferred.make<void>();
          // The real adapter constructs a new AuthorHistory owner for each invocation.
          const pending = yield* library.update(undefined, adapters).pipe(
            Effect.provideService(Clock.Clock, {
              currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
              currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
              monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
              currentTimeMillis: clock.currentTimeMillis,
              currentTimeNanos: clock.currentTimeNanos,
              monotonicTimeNanos: clock.monotonicTimeNanos,
              sleep: (duration) =>
                (Duration.toMillis(duration) === 10_000
                  ? Deferred.succeed(waiting, undefined)
                  : Effect.void
                ).pipe(Effect.andThen(clock.sleep(duration))),
            }),
            Effect.forkScoped,
          );
          yield* Deferred.await(waiting);
          assert.isTrue(
            yield* fs.exists(
              join(agents, change === "file" ? "review/notes.txt" : "review/SKILL.md"),
            ),
          );
          yield* Effect.sync(() => assertHomeWriterAvailable(home));
          yield* TestClock.adjust("9 seconds");
          assert.isTrue(yield* fs.exists(join(agents, "review/SKILL.md")));
          yield* TestClock.adjust("1 second");
          const result = yield* Fiber.join(pending);
          assert.isFalse("status" in result[0]!, JSON.stringify(result));
          assert.isFalse(
            yield* fs.exists(join(agents, change === "file" ? "review/notes.txt" : "review")),
          );
          assert.strictEqual(
            yield* fs.readFileString(join(agents, "explain/SKILL.md")),
            content("explain", "Initial"),
          );
        }
        const before = yield* library.read;
        yield* library.update(undefined, adapters);
        assert.strictEqual((yield* library.read).revision, before.revision);
      }).pipe(Effect.provide(owners));
    }).pipe(Effect.scoped, Effect.provide(testPlatformLayer)),
);
