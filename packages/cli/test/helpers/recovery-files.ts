import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { createHash } from "node:crypto";
import { LinkStat } from "@smolai/skit-core/platform";
import { deterministicTreeHash } from "@smolai/skit-core/author";
import { dirname, join } from "node:path";
import * as Library from "@smolai/skit-core/library";
import { testRoots } from "./roots.js";
/** Native evidence for test-owned paths; never invokes Library's evidence reader or verifier. */
export const recoveryFolderFixture = Effect.fn("Test.recoveryFolderFixture")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const info = yield* links.identity.lstat(path);
  const parentPath = yield* links.realPathNative(dirname(path));
  const parentInfo = yield* links.identity.lstat(parentPath);
  const identity = { path, dev: info.dev, ino: info.ino };
  const parent = { path: parentPath, dev: parentInfo.dev, ino: parentInfo.ino };
  const hash = createHash("sha256");
  // Released custody format: length-framed path/type/mode facts and raw bytes, with no exclusions.
  const append = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    hash.update(`${bytes.byteLength}:`).update(bytes);
  };
  const visit = (at: string, relative: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      const stat = yield* links.lstat(at);
      append(JSON.stringify([relative, stat.type, stat.mode]));
      if (stat.type === "File") append(yield* fs.readFile(at));
      else if (stat.type === "SymbolicLink") append(yield* fs.readLink(at));
      else if (stat.type === "Directory")
        for (const name of (yield* fs.readDirectory(at)).sort())
          yield* visit(join(at, name), join(relative, name));
      else return yield* Effect.die(`Unsupported recovery fixture entry: ${at}`);
    });
  yield* visit(path, "");
  const contentHash = `sha256:${hash.digest("hex")}`;
  if (info.type === "Directory") {
    const marker = yield* fs.readFileString(join(path, ".skit-ownership.json")).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    );
    return {
      _tag: "Directory",
      ...identity,
      parent,
      contentHash,
      treeHash: yield* deterministicTreeHash(path),
      marker,
    } satisfies Library.FolderEvidence;
  }
  if (info.type === "SymbolicLink")
    return {
      _tag: "SymbolicLink",
      ...identity,
      parent,
      contentHash,
      linkTarget: yield* fs.readLink(path),
      canonicalPath: yield* links.realPathNative(path),
    } satisfies Library.LinkEvidence;
  return yield* Effect.die(`Expected a recovery folder or link: ${path}`);
});

/** Create recovery fixtures through the same recorded owner used by setup. */
export const saveRecoveryFiles = (home: string, paths: readonly string[]) =>
  Effect.gen(function* () {
    const owner = yield* Library.Service;
    const folders = yield* Effect.forEach(paths, recoveryFolderFixture);
    const result = yield* owner.setup([{ _tag: "Remove", folders }], { base: yield* owner.read });
    return { result, operationDirectory: join(home, "removed", result.operationId) };
  }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
