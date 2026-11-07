import { join, resolve } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { deterministicTreeHash } from "../../artifact/skit.js";
import { LinkStat } from "../../platform/link-stat.js";
import { type DuplicateCopy } from "../duplicates.js";
import { checkSetupGlobalContent } from "../internal/setup/protection.js";
import { StalePlan } from "../library-plan.js";
import { SetupApprovedCopy } from "./decisions.js";

/** Only direct, equal global copies approved by review can enter automatic preservation. */
export const recordSetupCopies = Effect.fn("Setup.captureCopies")(function* (
  sourcePath: string,
  duplicates: readonly DuplicateCopy[],
  approved?: readonly SetupApprovedCopy[],
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const present = (path: string) =>
    links.lstat(path).pipe(
      Effect.as(true),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
  const selectedHash = yield* deterministicTreeHash(sourcePath);
  const paths = [
    ...new Set(
      duplicates.flatMap((duplicate) =>
        duplicate.aliases.map((alias) => {
          if (alias.via !== "directory" || alias.path !== duplicate.canonicalPath) return "";
          return alias.path;
        }),
      ),
    ),
  ].sort();
  if (!paths.length || paths.includes(""))
    return yield* new StalePlan({ message: "The Library changed since this was previewed" });
  const copies = yield* Effect.forEach(paths, (path) =>
    Effect.gen(function* () {
      yield* checkSetupGlobalContent(path);
      const info = yield* links.identity.lstat(path);
      if (info.type !== "Directory" || (yield* fs.realPath(path)) !== resolve(path))
        return yield* new StalePlan({ message: "The Library changed since this was previewed" });
      for (const name of [".skit-ownership.json", "skit.remote.json", "skit.json", ".skit"])
        if (yield* present(join(path, name)))
          return yield* new StalePlan({ message: "The Library changed since this was previewed" });
      const currentHash = yield* deterministicTreeHash(path);
      if (currentHash !== selectedHash)
        return yield* new StalePlan({ message: "The Library changed since this was previewed" });
      return { path, currentHash, dev: info.dev, ino: info.ino };
    }),
  );
  if (
    approved &&
    !Schema.toEquivalence(Schema.Array(SetupApprovedCopy))(
      copies,
      [...approved].sort((left, right) => left.path.localeCompare(right.path)),
    )
  )
    return yield* new StalePlan({ message: "The Library changed since this was previewed" });
  return copies;
});
