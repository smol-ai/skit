import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Effect, Schema } from "effect";

class MigrationCheckFailed extends Schema.TaggedError<
  MigrationCheckFailed,
  { readonly brand: unique symbol }
>()("MigrationCheckFailed", {
  message: Schema.String,
}) {}

const directory = "packages/skit-server-effect/migrations/";
const git = (cwd: string, args: string[]) =>
  Effect.gen(function* () {
    const result = yield* Effect.try({
      try: () => spawnSync("git", args, { cwd, encoding: "utf8" }),
      catch: (cause) => new MigrationCheckFailed({ message: String(cause) }),
    });
    if (result.status !== 0)
      return yield* new MigrationCheckFailed({
        message: `git ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`,
      });
    return result.stdout;
  });

/** Compare committed blobs at the common ancestor, so target-branch additions are not deletions. */
export const checkFrozenMigrations = (cwd: string, base: string | undefined, head = "HEAD") =>
  Effect.gen(function* () {
    if (!base || /^0+$/.test(base))
      return yield* new MigrationCheckFailed({
        message: "A valid migration comparison base is required",
      });
    const ancestor = (yield* git(cwd, ["merge-base", base, head])).trim();
    const trees: Map<string, string>[] = [];
    for (const ref of [ancestor, head]) {
      const rows = yield* git(cwd, ["ls-tree", "-rz", ref, "--", directory]);
      const files = new Map<string, string>();
      for (const row of rows.split("\0")) {
        const separator = row.indexOf("\t");
        if (separator < 0) continue;
        const path = row.slice(separator + 1);
        if (path.endsWith(".sql")) files.set(path, row.slice(0, separator));
      }
      trees.push(files);
    }
    const [previous, current] = trees;
    const changed = [...previous]
      .filter(([path, blob]) => current.get(path) !== blob)
      .map(([path]) => path);
    if (changed.length)
      return yield* new MigrationCheckFailed({
        message: `D1 migrations already on dev must not change. Add a new migration instead:\n${changed.join("\n")}`,
      });
  });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // oxlint-disable-next-line skit/no-nested-runtime -- Standalone CI command process entrypoint.
  const result = await Effect.runPromise(
    Effect.result(checkFrozenMigrations(process.cwd(), process.argv[2], process.argv[3] ?? "HEAD")),
  );
  if (result._tag === "Failure") {
    console.error(result.failure.message);
    process.exitCode = 1;
  }
}
