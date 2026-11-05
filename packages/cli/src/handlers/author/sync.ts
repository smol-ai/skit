import { SkitConfiguration, skitConfigurationLayer } from "@smolai/skit-core";
import { Effect, Option } from "effect";
import type { AuthorVisibility } from "@smolai/skit-core/author";
import { Argument, Command, Flag } from "effect/cli";
import { Renderer } from "../../terminal/renderer.js";
import { syncAuthorWorkspace } from "../../workflows/author/sync.js";
import { handleSourceCommand } from "../../commands/handler.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, jsonFlag, optionalString } from "../../commands/parameters.js";
import { result } from "../../commands/result.js";

export const authorSyncCommand = Effect.fn("CLI.authorSync")(function* (options: {
  readonly root?: string;
  readonly apply: boolean;
  readonly allowLargeDeletion?: boolean;
  readonly home?: string;
  readonly to?: string;
  readonly visibility?: AuthorVisibility;
}) {
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Synchronizing skit",
    Effect.scoped(
      syncAuthorWorkspace(options.root ?? ".", {
        apply: options.apply,
        allowLargeDeletion: options.allowLargeDeletion,
        home: options.home,
        to: options.to,
        visibility: options.visibility,
      }),
    ),
  );
});

const path = Argument.String("path").pipe(Argument.optional);
const to = optionalString("to", "Select the first remote SKIT destination.");
const visibility = Flag.Literals("visibility", ["private", "unlisted", "public"] as const).pipe(
  Flag.withDescription("Set visibility when creating the remote SKIT."),
  Flag.optional,
);
const apply = Flag.Boolean("apply").pipe(
  Flag.withDescription("Apply the sync plan."),
  Flag.withDefault(false),
);

const allowLargeDeletion = Flag.Boolean("allow-large-deletion").pipe(
  Flag.withDescription("Allow deleting all files, or more than five files and half the tree."),
  Flag.withDefault(false),
);

export const authorSyncCliCommand = Command.make(
  "sync",
  { path, to, visibility, apply, allowLargeDeletion, home: homeFlag, json: jsonFlag },
  ({ path, to, visibility, apply, allowLargeDeletion, home }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      return yield* handleSourceCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const value = yield* authorSyncCommand({
            root: Option.getOrUndefined(path),
            apply,
            allowLargeDeletion,
            home: selectedHome,
            to: Option.getOrUndefined(to),
            visibility: Option.getOrUndefined(visibility),
          });
          yield* renderer.result(
            result("sync", value, value.status === "blocked" ? 12 : undefined),
          );
        }),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(home)))),
).pipe(
  Command.withDescription("Synchronize an author workspace with its Registry revisions."),
  Command.withExamples([
    { command: "skit author sync . --to tim/tools --visibility private" },
    { command: "skit author sync . --to tim/tools --visibility private --apply" },
    { command: "skit author sync . --apply" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.sync],
    exitCodes: [0, 11, 12, 13, 64, 65],
    interactive: false,
  }),
);
