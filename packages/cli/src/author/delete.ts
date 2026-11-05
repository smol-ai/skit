import { SkitConfiguration, skitConfigurationLayer } from "@smolai/skit-core";
import { Option, Effect, Result } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { parseAuthorDestination } from "./destination.js";
import { Registry, type ResolvedAuth } from "../registry/index.js";
import { deletePrivateAuthorSkit } from "../registry/authoring.js";
import { Renderer } from "../terminal/renderer.js";
import { handleRegistryCommand } from "../commands/handler.js";
import { CommandMetadata } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { homeFlag, jsonFlag } from "../commands/parameters.js";
import { result } from "../commands/result.js";

export interface AuthorDeleteOptions<E> {
  readonly authState: Result.Result<ResolvedAuth, E>;
  readonly home?: string;
  readonly dryRun?: boolean;
}

/** Resolve one startup snapshot, destination and credential before issuing one scoped DELETE. */
export const authorDeleteCommand = Effect.fn("CLI.authorDelete")(function* <E>(
  destination: string,
  options: AuthorDeleteOptions<E>,
) {
  const concrete = /^(?:skit:\/\/|https?:\/\/)/.test(destination);
  const startup = concrete ? undefined : yield* Effect.fromResult(options.authState);
  const remote = yield* parseAuthorDestination(destination, startup?.origin);
  const credentials = yield* Registry.credentials({ origin: remote.origin, home: options.home });
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    options.dryRun ? "Planning private SKIT deletion" : "Deleting private SKIT",
    Effect.scoped(
      deletePrivateAuthorSkit(remote, { token: credentials.token, dryRun: options.dryRun }),
    ),
  );
});

const skit = Argument.String("skit");
const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Preview the private SKIT and Releases that would be deleted."),
  Flag.withDefault(false),
);

export const authorDeleteCliCommand = Command.make(
  "delete",
  { skit, dryRun, home: homeFlag, json: jsonFlag },
  ({ skit, dryRun, home }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      return yield* handleRegistryCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const authState = yield* Registry.credentials({ home: selectedHome }).pipe(Effect.result);
          const value = yield* authorDeleteCommand(skit, {
            authState,
            home: selectedHome,
            dryRun,
          });
          yield* renderer.result(result("authorDelete", value));
        }),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(home)))),
).pipe(
  Command.withDescription("Permanently delete a private SKIT from its Registry."),
  Command.withExamples([
    { command: "skit author delete skit://skit.example.com/alice/tools --dry-run" },
    { command: "skit author delete skit://skit.example.com/alice/tools" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.authorDelete],
    exitCodes: [0, 11, 12, 13, 64, 65],
    interactive: false,
  }),
);
