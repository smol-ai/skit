import { skitConfigurationLayer } from "../../configuration/skit-configuration.js";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { MissingRequirement } from "../../workflows/failures.js";
import { publish } from "../../workflows/author/publish.js";
import { Renderer } from "../../presentation/renderer.js";
import { handleRegistryCommand } from "../../application.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { jsonFlag, optionalString } from "../../commands/parameters.js";
import { result } from "../contracts.js";

export const publishCommand = Effect.fn("CLI.publish")(function* (options: {
  readonly root?: string;
  readonly version?: string;
  readonly revision?: string;
  readonly home?: string;
}) {
  if (!options.version)
    return yield* new MissingRequirement({ command: "publish", requires: "--version" });

  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Packaging and publishing release",
    publish(options.root ?? ".", options.version, options.revision, { home: options.home }),
  );
});

const path = Argument.String("path").pipe(Argument.optional);
const version = Flag.String("version").pipe(
  Flag.withMetavar("semver"),
  Flag.withDescription("Release version (required)."),
);
const revision = optionalString("revision", "Require an exact current skit revision.");

export const publishCliCommand = Command.make(
  "publish",
  { path, version, revision, json: jsonFlag },
  ({ path, version, revision }) =>
    handleRegistryCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const value = yield* publishCommand({
          root: Option.getOrUndefined(path),
          version,
          revision: Option.getOrUndefined(revision),
        });
        yield* renderer.result(result("publish", value));
      }),
    ).pipe(Effect.provide(skitConfigurationLayer())),
).pipe(
  Command.withDescription("Package and publish an immutable SKIT release."),
  Command.withExamples([
    { command: "skit author publish . --version 1.0.0" },
    {
      command:
        "skit author publish . --version 1.0.0 --revision sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.publish],
    exitCodes: [0, 12, 13, 64, 65],
    interactive: false,
  }),
);
