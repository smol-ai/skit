import { Effect, FileSystem } from "effect";
import { join } from "node:path";

export const writeCommandContractArtifacts = Effect.fn("CLI.writeCommandContractArtifacts")(
  function* (target: string, artifacts: Readonly<Record<string, string>>) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(target, { recursive: true });
    for (const name of yield* fs.readDirectory(target))
      if (name.endsWith(".json") && !Object.hasOwn(artifacts, name))
        yield* fs.remove(join(target, name));
    for (const [name, contents] of Object.entries(artifacts)) {
      const path = join(target, name);
      const existing = yield* fs
        .readFileString(path)
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        );
      if (existing !== contents) yield* fs.writeFileString(path, contents);
    }
  },
);
