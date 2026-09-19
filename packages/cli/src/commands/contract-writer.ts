import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";

export class ContractShapeChanged extends Schema.TaggedError<ContractShapeChanged>()(
  "CLI.ContractShapeChanged",
  { contract: Schema.String },
) {}

export const writeCommandContractArtifacts = Effect.fn("CLI.writeCommandContractArtifacts")(
  function* (target: string, artifacts: Readonly<Record<string, string>>) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(target, { recursive: true });
    for (const [name, contents] of Object.entries(artifacts)) {
      const path = join(target, name);
      const existing = yield* fs
        .readFileString(path)
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        );
      if (name !== "command-manifest.json" && existing !== undefined && existing !== contents)
        return yield* new ContractShapeChanged({ contract: name });
      if (existing !== contents) yield* fs.writeFileString(path, contents);
    }
  },
);
