import { readSkitDescriptorEffect } from "@smolai/skit-core";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { resolve } from "node:path";
import { resolveAuthForOriginEffect } from "../../registry/auth.js";
import { MissingRequirement } from "../failures.js";
import { publishEffect } from "../../workflows/author/publish.js";
import { AuthenticationRequired } from "../../registry/failures.js";
import { Renderer } from "../../presentation/renderer.js";
import { readAuthorRemoteEffect } from "../../workflows/author/sync.js";
import { NotBoundToRegistry } from "../../registry/failures.js";
import { handleCommand } from "../../application.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { jsonFlag, optionalString } from "../../commands/parameters.js";
import { result } from "../contracts.js";

const requireRegistryBindingEffect = Effect.fn("Publish.requireRegistryBinding")(function* (
  path: string,
) {
  yield* readSkitDescriptorEffect(resolve(path));
  const remote = yield* readAuthorRemoteEffect(resolve(path));
  if (!remote) return yield* new NotBoundToRegistry();
  return remote;
});

export const publishCommand = Effect.fn("CLI.publish")(function* (options: {
  readonly root?: string;
  readonly version?: string;
  readonly revision?: string;
  readonly home?: string;
}) {
  if (!options.version)
    return yield* new MissingRequirement({ command: "publish", requires: "--version" });

  const root = options.root ?? ".";
  const remote = yield* requireRegistryBindingEffect(root);
  const credentials = yield* resolveAuthForOriginEffect(remote.origin, options.home);
  if (!credentials.token)
    return yield* new AuthenticationRequired({
      origin: remote.origin,
      scopes: "library:sync,authoring:write,publication:write",
    });

  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Packaging and publishing release",
    publishEffect(root, options.version, options.revision, {
      baseUrl: credentials.origin,
      token: credentials.token,
    }),
  );
});

const path = Argument.string("path").pipe(Argument.optional);
const version = Flag.string("version").pipe(
  Flag.withMetavar("semver"),
  Flag.withDescription("Release version (required)."),
);
const revision = optionalString("revision", "Require an exact current draft revision.");

export const publishCliCommand = Command.make(
  "publish",
  { path, version, revision, json: jsonFlag },
  ({ path, version, revision }) =>
    handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const value = yield* publishCommand({
          root: Option.getOrUndefined(path),
          version,
          revision: Option.getOrUndefined(revision),
        });
        yield* renderer.result(result("publish", outputContracts.publish, value));
      }),
    ),
).pipe(
  Command.withDescription("Package and publish an immutable SKIT release."),
  Command.withExamples([
    { command: "skit author publish . --version 1.0.0" },
    { command: "skit author publish . --version 1.0.0 --revision draft_abc123" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.publish],
    exitCodes: [0, 12, 64, 65],
    interactive: false,
  }),
);
