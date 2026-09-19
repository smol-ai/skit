import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { originalTreeHashEffect } from "./retention/retain-tree.js";
import { walkTreeEffect } from "../artifact/tree.js";
import { SnapshotArchive, type SnapshotArchiveEntry } from "./library-contracts.js";
import {
  SnapshotArchiveInvalid,
  verifySnapshotArchiveEffect,
} from "./snapshot-archive-universal.js";

export {
  SnapshotArchiveInvalid,
  verifySnapshotArchiveEffect,
} from "./snapshot-archive-universal.js";

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
};

/** Capture only verbatim-tree members; `.git` and SKIT residue are excluded by that profile. */
export const captureSnapshotArchiveEffect = Effect.fn("Library.captureSnapshotArchive")(function* (
  root: string,
) {
  const entries: SnapshotArchiveEntry[] = [];
  for (const entry of yield* walkTreeEffect(root, "verbatim")) {
    if (entry.kind === "file")
      entries.push({
        path: entry.path,
        kind: "file",
        mode: entry.mode,
        content_base64: base64(entry.bytes),
      });
    else entries.push(entry);
  }
  return SnapshotArchive.make({
    profile: "verbatim/v1",
    digest: yield* originalTreeHashEffect(root),
    entries,
  });
});

/** Materialize only a previously verified archive in an owned scoped workspace. */
export const materializeVerifiedSnapshotEffect = Effect.fn("Library.materializeVerifiedSnapshot")(
  function* (verified: Effect.Success<ReturnType<typeof verifySnapshotArchiveEffect>>) {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-private-snapshot-" });
    for (const entry of verified.entries) {
      const path = join(root, entry.path);
      if (entry.kind === "directory") yield* fs.makeDirectory(path, { mode: 0o700 });
      if (entry.kind === "file") {
        const bytes = verified.files.get(entry.path);
        if (bytes === undefined)
          return yield* new SnapshotArchiveInvalid({ reason: `missing file: ${entry.path}` });
        yield* fs.writeFile(path, bytes, { flag: "wx", mode: entry.mode });
      }
      if (entry.kind === "symlink") yield* fs.symlink(entry.target, path);
    }
    if ((yield* originalTreeHashEffect(root)) !== verified.archive.digest)
      return yield* new SnapshotArchiveInvalid({ reason: "materialized tree digest mismatch" });
    return root;
  },
);
