import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import { PackageMetadataUnavailable } from "./failures.js";
import { Command } from "effect/unstable/cli";
import { handleReadOnlyCommand } from "../application.js";
import { CommandMetadata } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { jsonFlag } from "../commands/parameters.js";
import { Renderer } from "../presentation/renderer.js";
import { result } from "./contracts.js";

const PackageMetadata = Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString }));

export const versionCommand = Effect.fn("CLI.version")(function* (
  paths: readonly string[] = [
    join(import.meta.dirname, "..", "..", "package.json"),
    join(import.meta.dirname, "..", "..", "..", "package.json"),
  ],
) {
  const fs = yield* FileSystem.FileSystem;
  for (const path of paths) {
    const contents = yield* fs
      .readFileString(path)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
    if (contents === undefined) continue;
    const metadata = yield* Schema.decodeUnknownEffect(PackageMetadata)(contents).pipe(
      Effect.mapError(() => new PackageMetadataUnavailable()),
    );
    return metadata.version;
  }
  return yield* new PackageMetadataUnavailable();
});

export const versionCliCommand = Command.make("version", { json: jsonFlag }, () =>
  handleReadOnlyCommand(
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const version = yield* versionCommand();
      yield* renderer.result(result("version", outputContracts.version, { version }));
    }),
  ),
).pipe(
  Command.withDescription("Print the installed CLI version."),
  Command.withExamples([{ command: "skit version" }]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.version],
    exitCodes: [0],
    interactive: false,
  }),
);
