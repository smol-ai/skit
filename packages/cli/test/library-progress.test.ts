import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { join } from "node:path";
import {
  createSkitArchiveEffect,
  LibraryActor,
  LibraryAuditLog,
  LibraryStore,
  skitLayer,
} from "@smolai/skit-core";
import {
  LibraryProgress,
  libraryProgressLayer,
  type LibraryProgressEvent,
} from "../src/library-application/progress.js";
import { updateSubjectsEffect } from "../src/library-application/update.js";
import { addLibrarySourceEffect } from "../src/workflows/library/add.js";
import { copySkitFixtureEffect, libraryHome } from "./helpers/library-home.js";

it.effect("a headless update emits domain progress and records one attributed transaction", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-headless-update-" });
    const source = join(root, "source");
    yield* copySkitFixtureEffect("authored", source);
    const archivePath = join(root, "source.zip");
    const archive = Effect.gen(function* () {
      yield* fs.remove(archivePath, { force: true });
      yield* createSkitArchiveEffect(source, archivePath);
      return yield* fs.readFile(archivePath);
    });
    let bytes = yield* archive;
    const home = yield* libraryHome({
      home: join(root, "home"),
      transport: () =>
        Effect.succeed(
          new Response(new Uint8Array(bytes), {
            headers: { "content-type": "application/zip" },
          }),
        ),
    });
    yield* home.owned(
      addLibrarySourceEffect({ type: "archive", url: "https://fixtures.test/source.zip" }),
    );
    const before = yield* home.durable;
    const events: LibraryProgressEvent[] = [];
    const history = home.owned(LibraryAuditLog.use((log) => log.list()));
    const previousEvents = (yield* history).length;
    const skillPath = join(source, "skills", "review", "SKILL.md");
    yield* fs.writeFileString(skillPath, `${yield* fs.readFileString(skillPath)}\nUpdated body.\n`);
    bytes = yield* archive;
    const results = yield* home
      .owned(
        updateSubjectsEffect(before, {
          roots: home.inventory,
        }).pipe(
          Effect.provide(
            libraryProgressLayer((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
          ),
        ),
      )
      .pipe(Effect.provideService(LibraryActor, "headless"));
    assert.strictEqual(results.length, 1);
    assert.isTrue("changed" in results[0]! && results[0].changed);
    assert.deepStrictEqual(
      events.map((event) => [event.kind, event.stage.kind]),
      [
        ["started", "source"],
        ["completed", "source"],
        ["started", "projection"],
        ["completed", "projection"],
      ],
    );
    const after = yield* home.owned(LibraryStore.use((store) => store.load));
    assert.notStrictEqual(
      after.retained_copies.at(-1)?.digest,
      before.retained_copies.at(-1)?.digest,
    );
    const recorded = yield* history;
    assert.strictEqual(recorded.length, previousEvents + 1);
    assert.strictEqual(recorded.at(-1)?.workflow, "headless");
    assert.isFalse(yield* fs.exists(join(home.home, ".lock")));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("progress reports interruption after asynchronous stage cleanup finishes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cleaning = yield* Deferred.make<void>();
    const releaseCleanup = yield* Deferred.make<void>();
    const events: LibraryProgressEvent[] = [];
    const progress = yield* LibraryProgress.pipe(
      Effect.provide(
        libraryProgressLayer((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
      ),
    );
    const fiber = yield* progress
      .around(
        { kind: "source", subject: { id: "fixture", label: "Fixture" } },
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(releaseCleanup)),
            ),
          ),
        ),
        () => ({ kind: "source-inspected", changed: false }),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
    yield* Deferred.await(cleaning);
    // The stage cannot be reported closed while its resources are still being released.
    assert.deepStrictEqual(
      events.map((event) => event.kind),
      ["started"],
    );
    yield* Deferred.succeed(releaseCleanup, undefined);
    yield* Fiber.join(interrupted);
    assert.deepStrictEqual(
      events.map((event) => event.kind),
      ["started", "failed"],
    );
  }),
);
