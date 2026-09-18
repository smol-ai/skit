import { Effect, Option, Result } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { ResolvedAuth } from "../../registry/auth.js";
import { resolveAuthForOriginEffect } from "../../registry/auth.js";
import { AuthenticationRequired } from "../../registry/failures.js";
import { Renderer } from "../../presentation/renderer.js";
import {
  parseAuthorDestinationEffect,
  readAuthorRemoteEffect,
  syncDraftEffect,
  type AuthorVisibility,
} from "../../workflows/author/sync.js";
import { handleCommand } from "../../application.js";
import { resolveAuthEffect } from "../../registry/auth.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, homePath, jsonFlag, optionalString } from "../../commands/parameters.js";
import { result } from "../contracts.js";

export const authorSyncCommand = Effect.fn("CLI.authorSync")(function* <AuthError>(options: {
  readonly root?: string;
  readonly apply: boolean;
  readonly home?: string;
  readonly to?: string;
  readonly visibility?: AuthorVisibility;
  readonly authState: Result.Result<ResolvedAuth, AuthError>;
}) {
  const storedRemote = yield* readAuthorRemoteEffect(options.root ?? ".");
  let credentials = storedRemote
    ? yield* resolveAuthForOriginEffect(storedRemote.origin, options.home)
    : undefined;
  if (options.to) {
    const concrete = /^(?:skit:\/\/|https?:\/\/)/.test(options.to);
    const startup = concrete ? undefined : yield* Effect.fromResult(options.authState);
    const destination = yield* parseAuthorDestinationEffect(options.to, startup?.origin);
    credentials = yield* resolveAuthForOriginEffect(destination.origin, options.home);
    if (!credentials.token)
      return yield* new AuthenticationRequired({
        origin: destination.origin,
        scopes: "library:sync,authoring:write",
      });
  }
  if (!credentials)
    credentials =
      !storedRemote && !options.to
        ? { source: "none" as const }
        : yield* Effect.fromResult(options.authState);

  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Synchronizing draft",
    Effect.scoped(
      syncDraftEffect(options.root ?? ".", {
        apply: options.apply,
        home: options.home,
        baseUrl: credentials.origin,
        token: credentials.token,
        to: options.to,
        visibility: options.visibility,
      }),
    ),
  );
});

const path = Argument.string("path").pipe(Argument.optional);
const to = optionalString("to", "Select the first remote SKIT destination.");
const visibility = Flag.choice("visibility", ["private", "unlisted", "public"] as const).pipe(
  Flag.withDescription("Set visibility when creating the remote SKIT."),
  Flag.optional,
);
const apply = Flag.boolean("apply").pipe(
  Flag.withDescription("Apply a conflict-free merge."),
  Flag.withDefault(false),
);

export const authorSyncCliCommand = Command.make(
  "sync",
  { path, to, visibility, apply, home: homeFlag, json: jsonFlag },
  ({ path, to, visibility, apply, home }) => {
    const selectedHome = homePath(home);
    return handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const authState = yield* resolveAuthEffect(selectedHome).pipe(Effect.result);
        const value = yield* authorSyncCommand({
          root: Option.getOrUndefined(path),
          apply,
          home: selectedHome,
          to: Option.getOrUndefined(to),
          visibility: Option.getOrUndefined(visibility),
          authState,
        });
        const conflicted = value.status === "conflicted" || value.status === "unbound_conflict";
        yield* renderer.result(
          result("sync", outputContracts.sync, value, conflicted ? 12 : undefined),
        );
      }),
      selectedHome,
    );
  },
).pipe(
  Command.withDescription("Synchronize a local SKIT with its remote draft."),
  Command.withExamples([
    { command: "skit author sync . --to tim/tools --visibility private" },
    { command: "skit author sync . --to tim/tools --visibility private --apply" },
    { command: "skit author sync . --apply" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.sync],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
