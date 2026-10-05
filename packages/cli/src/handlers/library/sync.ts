import { Effect, Result } from "effect";
import { Command, Flag } from "effect/cli";
import { handleCommand } from "../../application.js";
import type { ResolvedAuth } from "../../registry/auth.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags, optionalString, optionValue } from "../../commands/parameters.js";
import { syncLibraryEffect } from "../../workflows/library/library-sync.js";
import type { LibraryInstallationConfiguration } from "../../library/installation-configuration.js";
import { NoStoredCredentials } from "../../registry/failures.js";
import { Renderer } from "../../presentation/renderer.js";
import { createColors } from "picocolors";
import { result } from "../contracts.js";
import { renderLibrarySyncPlan } from "../../presentation/library-sync.js";

export const librarySyncCommand = Effect.fn("CLI.librarySync")(function* <AuthError>(options: {
  readonly authState: Result.Result<ResolvedAuth, AuthError>;
  readonly apply: boolean;
  readonly adopt: boolean;
  readonly takeRemote?: readonly string[];
  readonly keepEnabled?: readonly string[];
  readonly projection: Pick<LibraryInstallationConfiguration, "variantsPath" | "rootFor">;
}) {
  const auth = yield* Effect.fromResult(options.authState);
  if (auth.origin === undefined) return yield* new NoStoredCredentials();
  const renderer = yield* Renderer;
  return yield* Effect.scoped(
    renderer.withStatus(
      "Preparing Library sync",
      syncLibraryEffect({
        origin: auth.origin,
        ...(auth.token === undefined ? {} : { token: auth.token }),
        apply: options.apply,
        adopt: options.adopt,
        ...(options.takeRemote === undefined ? {} : { takeRemote: options.takeRemote }),
        ...(options.keepEnabled === undefined ? {} : { keepEnabled: options.keepEnabled }),
        projection: options.projection,
        onProgress: renderer.updateStatus,
        ...(options.apply
          ? {
              onPlan: (plan) =>
                renderer.note(renderLibrarySyncPlan(plan), "Applying Library sync plan", {
                  renderBody: (color) => renderLibrarySyncPlan(plan, createColors(color)),
                }),
            }
          : {}),
      }),
    ),
  );
});

const apply = Flag.Boolean("apply").pipe(
  Flag.withDescription("Apply the current Library reconciliation plan."),
  Flag.withDefault(false),
);
const adopt = Flag.Boolean("adopt").pipe(
  Flag.withDescription(
    "Explicitly adopt the current remote Library, setting aside ancestry from another Library.",
  ),
  Flag.withDefault(false),
);
const takeRemote = Flag.String("take-remote").pipe(
  Flag.withDescription(
    "Resolve a named Collection or Binding conflict from the current remote Library.",
  ),
  Flag.atLeast(0),
);
const registry = optionalString("registry", "Select the Registry to synchronize.");
const keepEnabled = Flag.String("keep-enabled").pipe(
  Flag.withDescription(
    "Resolve a destination collision by keeping this Skill ID enabled; retain the other Skills without enabling them.",
  ),
  Flag.atLeast(0),
);

export const librarySyncCliCommand = Command.make(
  "sync",
  { apply, adopt, takeRemote, keepEnabled, registry, ...localFlags },
  (input) =>
    handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const configuration = yield* libraryCommandConfiguration(
          input,
          optionValue(input.registry),
          "skit sync",
        );
        const value = yield* librarySyncCommand({
          authState: configuration.authState,
          apply: input.apply,
          adopt: input.adopt,
          takeRemote: input.takeRemote,
          keepEnabled: input.keepEnabled,
          projection: configuration.pull.installation,
        });
        yield* renderer.result(
          result(
            "librarySync",
            outputContracts.librarySync,
            value,
            value.status === "conflicted" ||
              value.status === "legacy_remote_conflict" ||
              value.status === "adoption_required" ||
              value.status === "base_mismatch" ||
              value.status === "resolution_invalid"
              ? 12
              : undefined,
          ),
        );
      }),
      homePath(input.home),
    ),
).pipe(
  Command.withDescription("Synchronize private retained Library bytes with skit-server."),
  Command.withExamples([{ command: "skit sync" }, { command: "skit sync --apply" }]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.librarySync],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
