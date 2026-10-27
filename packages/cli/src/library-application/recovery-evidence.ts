import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { Digest, FailureTypeId, LinkStat, type SkitFailure } from "@smolai/skit-core";

export class RecoveryInvalid
  extends Schema.TaggedError<RecoveryInvalid>()("RecoveryInvalid", { detail: Schema.String })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get message() {
    return `Recovery cannot proceed: ${this.detail}`;
  }
  readonly remediation =
    "Inspect the saved files and their move record; keep both before resolving the conflict.";
}

/** Includes control files, empty directories and link text; never follows symlinks. */
export const recoveryFingerprint = Effect.fn("Recovery.fingerprint")(function* (
  root: string,
  ownership: "include" | "exclude" = "include",
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const hash = createHash("sha256");
  const append = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
  };
  const visit = (
    path: string,
    relative: string,
  ): Effect.Effect<
    void,
    RecoveryInvalid | Effect.Error<ReturnType<typeof fs.readDirectory>>,
    never
  > =>
    Effect.gen(function* () {
      if (ownership === "exclude" && relative === ".skit-ownership.json") return;
      const info = yield* links.lstat(path);
      append(JSON.stringify([relative, info.type, info.mode]));
      if (info.type === "SymbolicLink") append(yield* fs.readLink(path));
      else if (info.type === "File") append(yield* fs.readFile(path));
      else if (info.type === "Directory") {
        for (const name of (yield* fs.readDirectory(path)).sort())
          yield* visit(join(path, name), join(relative, name));
      } else return yield* new RecoveryInvalid({ detail: `Unsupported file type at ${path}` });
    });
  yield* visit(root, "");
  return Digest.make(`sha256:${hash.digest("hex")}`);
});
