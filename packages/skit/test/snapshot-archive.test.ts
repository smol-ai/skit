import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import { join } from "node:path";
import {
  readSnapshotArchive,
  writeVerifiedSnapshot,
  verifySnapshotArchive,
} from "../src/library/snapshot-archive.js";
import { originalTreeHash } from "../src/library/collection-version.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect("verifies real retained bytes and rejects a changed archive", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-snapshot-archive-" });
    yield* fs.makeDirectory(join(root, "skills", "review"), { recursive: true });
    yield* fs.makeDirectory(join(root, "empty"));
    yield* fs.makeDirectory(join(root, ".git"));
    yield* fs.writeFileString(join(root, ".git", "config"), "excluded");
    for (const name of ["z.md", "A.md", "_note.md", "é.md"])
      yield* fs.writeFileString(join(root, name), name);
    yield* fs.writeFile(join(root, "skills", "review", "SKILL.md"), Uint8Array.from([0, 1, 255]), {
      mode: 0o755,
    });
    yield* fs.symlink("SKILL.md", join(root, "skills", "review", "alias.md"));
    const archive = yield* readSnapshotArchive(root);
    assert.strictEqual(archive.digest, yield* originalTreeHash(root));
    assert.strictEqual(
      archive.entries.some((entry) => entry.path.startsWith(".git")),
      false,
    );
    const verified = yield* verifySnapshotArchive(archive);
    assert.deepStrictEqual(
      verified.entries.find(
        (entry) => entry.kind === "file" && entry.path === "skills/review/SKILL.md",
      ),
      {
        kind: "file",
        path: "skills/review/SKILL.md",
        mode: 0o755,
        bytes: Uint8Array.from([0, 1, 255]),
      },
    );
    const restored = yield* writeVerifiedSnapshot(verified);
    assert.strictEqual(yield* originalTreeHash(restored), archive.digest);
    assert.deepStrictEqual(
      yield* fs.readFile(join(restored, "skills", "review", "SKILL.md")),
      Uint8Array.from([0, 1, 255]),
    );
    const changed = {
      ...archive,
      entries: archive.entries.map((entry) =>
        entry.kind === "file" && entry.path === "skills/review/SKILL.md"
          ? { ...entry, content_base64: btoa("changed") }
          : entry,
      ),
    };
    const corruption = yield* verifySnapshotArchive(changed).pipe(Effect.result);
    assert.strictEqual(Result.isFailure(corruption), true);
    const unsafe = {
      ...archive,
      entries: [
        ...archive.entries,
        { kind: "file", path: "../escape", mode: 0o644, content_base64: "YQ==" },
      ],
    };
    const traversal = yield* verifySnapshotArchive(unsafe).pipe(Effect.result);
    assert.strictEqual(Result.isFailure(traversal), true);
    const changedBeforeWrite = {
      ...verified,
      entries: verified.entries.map((entry) =>
        entry.kind === "file" && entry.path === "skills/review/SKILL.md"
          ? { ...entry, bytes: Uint8Array.from([7, 8, 9]) }
          : entry,
      ),
    };
    const refused = yield* Effect.flip(writeVerifiedSnapshot(changedBeforeWrite));
    if (refused._tag !== "Library.SnapshotArchiveInvalid")
      return yield* Effect.die("Expected the written archive hash to be checked");
    assert.include(refused.reason, {
      _tag: "HashMismatch",
      kind: "materialized",
      expected: archive.digest,
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
