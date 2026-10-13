import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { skitLayer } from "@smolai/skit-core";
import { captureDisk, diskChanges, noDiskChanges } from "./helpers/disk-snapshot.js";

const workspace = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "skit-disk-snapshot-" }),
);

it.effect("reports a created name containing a newline as one exact path", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* workspace;
    yield* fs.makeDirectory(join(root, "a"));
    yield* fs.writeFileString(join(root, "a", "b"), "nested\n");
    const before = yield* captureDisk([root]);
    yield* fs.writeFileString(join(root, "a\nb"), "nested\n");
    yield* fs.chmod(join(root, "a\nb"), 0o600);
    assert.deepStrictEqual(yield* diskChanges(before), {
      ...noDiskChanges,
      created: [
        {
          path: [root, "a\nb"],
          after: { type: "file", mode: 0o600, content: `base64:${btoa("nested\n")}` },
        },
      ],
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reports the deletion of an empty directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* workspace;
    yield* fs.makeDirectory(join(root, "empty"));
    const before = yield* captureDisk([root]);
    yield* fs.remove(join(root, "empty"), { recursive: true });
    const changes = yield* diskChanges(before);
    assert.deepStrictEqual(
      changes.deleted.map((item) => item.path),
      [[root, "empty"]],
    );
    assert.deepStrictEqual([...changes.created, ...changes.changed], []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reports a mode change with identical bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* workspace;
    yield* fs.writeFileString(join(root, "script"), "#!/bin/sh\n");
    yield* fs.chmod(join(root, "script"), 0o644);
    const before = yield* captureDisk([root]);
    yield* fs.chmod(join(root, "script"), 0o755);
    const changes = yield* diskChanges(before);
    assert.deepStrictEqual(
      changes.changed.map((item) => [item.path, item.before.mode, item.after.mode]),
      [[[root, "script"], 0o644, 0o755]],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("reports a symlink replaced by a file holding the bytes it pointed at", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* workspace;
    const outside = yield* workspace;
    yield* fs.writeFileString(join(outside, "SKILL.md"), "same bytes\n");
    yield* fs.symlink(join(outside, "SKILL.md"), join(root, "SKILL.md"));
    const before = yield* captureDisk([root]);
    yield* fs.remove(join(root, "SKILL.md"));
    yield* fs.writeFileString(join(root, "SKILL.md"), "same bytes\n");
    const changes = yield* diskChanges(before);
    assert.deepStrictEqual(
      changes.changed.map((item) => [item.path, item.before.type, item.after.type]),
      [[[root, "SKILL.md"], "symlink", "file"]],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("does not traverse a linked directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* workspace;
    const outside = yield* workspace;
    yield* fs.symlink(outside, join(root, "linked"));
    const before = yield* captureDisk([root]);
    yield* fs.writeFileString(join(outside, "SKILL.md"), "outside the root\n");
    assert.deepStrictEqual(yield* diskChanges(before), noDiskChanges);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("tells a missing root from an empty one in both directions", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = join(yield* workspace, "root");
    const missing = yield* captureDisk([root]);
    yield* fs.makeDirectory(root);
    const created = yield* diskChanges(missing);
    assert.deepStrictEqual(
      created.created.map((item) => [item.path, item.after.type]),
      [[[root], "directory"]],
    );
    const empty = yield* captureDisk([root]);
    yield* fs.remove(root, { recursive: true });
    assert.deepStrictEqual(
      (yield* diskChanges(empty)).deleted.map((item) => [item.path, item.before.type]),
      [[[root], "directory"]],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
