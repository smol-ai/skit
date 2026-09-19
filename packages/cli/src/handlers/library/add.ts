import { Effect, Option, Result } from "effect";
import { sourceInputWithVersionEffect } from "@smolai/skit-core";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { handleCommand } from "../../application.js";
import { MissingRequirement } from "../failures.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags, optionalString } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";
import { RegistryAuth, type RegistryAuthAccess } from "../../registry/auth-service.js";
import {
  addPortableLibrarySourceEffect,
  previewPortableLibrarySourceEffect,
} from "../../workflows/library/portable-add.js";
import { rejectDedicatedInstallerSourceEffect } from "../../workflows/library/dedicated-installer-catalog.js";

const source = Argument.string("source");
const version = optionalString("version", "Select a source version.");
const registry = optionalString("registry", "Resolve a Registry source through a name or URL.");
const preview = Flag.boolean("list").pipe(
  Flag.withDescription("Preview discovered contents without adding them."),
  Flag.withDefault(false),
);

export const addCliCommand = Command.make(
  "add",
  { source, version, registry, preview, ...localFlags },
  (input) =>
    handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const registryAuth = yield* RegistryAuth;
        const requestedVersion = Option.getOrUndefined(input.version);
        const source = input.source
          ? yield* sourceInputWithVersionEffect(input.source, requestedVersion)
          : undefined;
        const locator = source
          ? yield* registryAuth.resolveLocator(source, Option.getOrUndefined(input.registry))
          : undefined;
        // An explicit Registry selection replaces an ambient configuration failure because it
        // supplies the concrete origin (and any credential stored for that origin) directly.
        const selectedAccess: RegistryAuthAccess | undefined = locator?.origin
          ? {
              authState: Result.succeed({
                origin: locator.origin,
                ...(locator.token === undefined ? {} : { token: locator.token }),
                source: locator.token === undefined ? "none" : "stored",
              }),
              origin: locator.origin,
              ...(locator.token === undefined ? {} : { token: locator.token }),
            }
          : undefined;
        const withSelectedRegistry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          selectedAccess === undefined
            ? effect
            : Effect.provideService(effect, RegistryAuth, {
                ...registryAuth,
                resolve: () => Effect.succeed(selectedAccess),
              });
        const selectedSource = locator?.input ?? source;
        if (!selectedSource)
          return yield* new MissingRequirement({ command: "add", requires: "<source>" });
        yield* rejectDedicatedInstallerSourceEffect(selectedSource);
        if (input.preview) {
          const value = yield* renderer.withStatus(
            `Inspecting ${selectedSource}`,
            withSelectedRegistry(
              previewPortableLibrarySourceEffect({}, selectedSource, requestedVersion),
            ),
          );
          return yield* renderer.result(result("add", outputContracts.addPreview, value));
        }
        const retained = yield* renderer.withStatus(
          "Retaining source",
          withSelectedRegistry(
            addPortableLibrarySourceEffect({}, selectedSource, requestedVersion),
          ),
        );
        yield* renderer.result(
          result("add", outputContracts.add, {
            ...(retained.collection_id === undefined
              ? {}
              : { collection_id: retained.collection_id }),
            skill_ids: retained.skill_ids,
            retained_version_id: retained.retained_version_id,
            snapshot_digest: retained.snapshot_digest,
            skills: retained.skills.map((skill) => ({
              name: skill.name,
              verbatim_path: skill.verbatim_path,
            })),
          }),
        );
      }),
      homePath(input.home),
    ),
).pipe(
  Command.withDescription("Add a source to the local library without enabling it."),
  Command.withExamples([
    { command: "skit add owner/repository" },
    { command: "skit add skit:owner/package@1.0.0" },
    { command: "skit add ./my-tools --list" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.add, outputContracts.addPreview],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
