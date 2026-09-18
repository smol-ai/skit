import { Deferred, Effect, Exit, Fiber, FileSystem } from "effect";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
  originalTreeHashEffect,
  retainLocalTreeEffect,
} from "../src/library/retention/retain-tree.js";
import { initSkitEffect } from "../src/authoring/scaffold.js";
import { deterministicTreeHashEffect } from "../src/artifact/skit.js";
import { skitLayer } from "../src/platform/layer.js";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-retention-" });
  const source = join(root, "source");
  yield* fs.makeDirectory(join(source, ".skit"), { recursive: true });
  yield* fs.makeDirectory(join(source, ".git"), { recursive: true });
  yield* fs.writeFileString(join(source, ".skit", "workspace.json"), "excluded");
  yield* fs.writeFileString(join(source, ".git", "ignored-object"), "not addressed");
  yield* fs.writeFileString(join(source, "file"), "original bytes");
  yield* fs.chmod(join(source, "file"), 0o751);
  return { root, source, objects: join(root, "objects") };
});

it.effect(
  "verbatim retention preserves links/modes and excludes metadata; address reuse is verified",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* fixture;
      yield* fs.symlink("file", join(f.source, "link"));
      const hash = yield* originalTreeHashEffect(f.source);
      const retained = yield* retainLocalTreeEffect(f.source, f.objects, hash, true);
      expect(yield* fs.readLink(join(retained, "link"))).toBe("file");
      expect((yield* fs.stat(join(retained, "file"))).mode & 0o777).toBe(0o751);
      expect(yield* fs.readDirectory(retained)).toEqual(["file", "link"]);
      expect(yield* originalTreeHashEffect(retained)).toBe(hash);
      yield* fs.writeFileString(join(retained, "file"), "corrupted");
      expect(
        yield* Effect.exit(retainLocalTreeEffect(f.source, f.objects, hash, true)),
      ).toMatchObject({
        _tag: "Failure",
      });
      expect(yield* fs.readFileString(join(retained, "file"))).toBe("corrupted");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each([true])(
  "source changes during copy fail verification and clean temporary output (verbatim=%s)",
  (verbatim) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* fixture;
      const hash = yield* verbatim
        ? originalTreeHashEffect(f.source)
        : deterministicTreeHashEffect(f.source);
      let changed = false;
      const exit = yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* retainLocalTreeEffect(f.source, f.objects, hash, verbatim).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            open: (path, options) =>
              Effect.gen(function* () {
                if (path === join(f.source, "file") && !changed) {
                  changed = true;
                  yield* fs.writeFileString(path, "changed during retention");
                }
                return yield* fs.open(path, options);
              }),
          }),
          Effect.exit,
        );
      });
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* fs.readDirectory(join(f.objects, hash.slice(7, 9)))).toEqual([]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each([true])(
  "copy interruption closes handles before removing temporary output (verbatim=%s)",
  (verbatim) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* fixture;
      const hash = yield* verbatim
        ? originalTreeHashEffect(f.source)
        : deterministicTreeHashEffect(f.source);
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const reached = yield* Deferred.make<void>();
        const operation = retainLocalTreeEffect(f.source, f.objects, hash, verbatim).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            open: (path, options) =>
              fs.open(path, options).pipe(
                Effect.map((file) =>
                  path === join(f.source, "file")
                    ? {
                        ...file,
                        readAlloc: () =>
                          Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
                      }
                    : file,
                ),
              ),
          }),
        );
        const fiber = yield* Effect.forkChild(operation);
        yield* Deferred.await(reached);
        yield* Fiber.interrupt(fiber);
      });
      expect(yield* fs.readDirectory(join(f.objects, hash.slice(7, 9)))).toEqual([]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("normalized retention materializes only normalized artifact membership", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const f = yield* fixture;
    yield* fs.writeFileString(join(f.source, ".DS_Store"), "excluded residue");
    yield* fs.writeFileString(join(f.source, ".skit-ownership.json"), "excluded custody");
    const hash = yield* deterministicTreeHashEffect(f.source);
    const retained = yield* retainLocalTreeEffect(f.source, f.objects, hash, false);
    expect(yield* fs.readDirectory(retained)).toEqual(["file"]);
    expect(yield* deterministicTreeHashEffect(retained)).toBe(hash);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("interrupted scaffold resumes its durable intent and preserves intervening edits", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const reached = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        initSkitEffect(f.source).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: (path, text, options) =>
              path.includes("SKILL.md.tmp-")
                ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
                : fs.writeFileString(path, text, options),
          }),
        ),
      );
      yield* Deferred.await(reached);
      yield* Fiber.interrupt(fiber);
    });
    yield* fs.writeFileString(
      join(f.source, "skills", "source", "agents", "openai.yaml"),
      "# user edit\npolicy:\n  allow_implicit_invocation: false\n",
    );
    yield* initSkitEffect(f.source);
    expect(
      JSON.parse(yield* fs.readFileString(join(f.source, "skit.json"))).skills[0],
    ).toMatchObject({ invocation: "explicit", default_enabled: true });
    expect(
      yield* fs.readFileString(join(f.source, "skills", "source", "agents", "openai.yaml")),
    ).toContain("# user edit");
    expect(
      (yield* fs.readDirectory(f.source, { recursive: true })).filter(
        (path) => path.includes(".tmp-") || path.endsWith("init-scaffold"),
      ),
    ).toEqual([]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
