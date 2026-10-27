import { skitConfigurationLayer } from "../../configuration/skit-configuration.js";
import { Effect, Option, Result } from "effect";
import { LibraryStore, sourceInputWithVersionEffect } from "@smolai/skit-core";
import {
  readDescriptionLoad,
  descriptionLoadMessage,
} from "../../workflows/library/collection-load.js";
import { Argument, Command, Flag } from "effect/cli";
import { handleSourceCommand } from "../../application.js";
import { MissingRequirement } from "../../workflows/failures.js";
import {
  CommandMetadata,
  credentialStoreReadSubprocesses,
  sourceAcquisitionSubprocesses,
} from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { localFlags, optionalString } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";
import { RegistryAuth, type RegistryAuthAccess } from "../../registry/auth-service.js";
import {
  retainLibrarySourceEffect,
  previewLibrarySourceEffect,
} from "../../library-application/source-acquisition.js";
import { rejectDedicatedInstallerSourceEffect } from "../../workflows/library/dedicated-installer-catalog.js";

const source = Argument.String("source");
const version = optionalString("version", "Select a source version.");
const registry = optionalString("registry", "Resolve a Registry source through a name or URL.");
const preview = Flag.Boolean("list").pipe(
  Flag.withDescription("Preview discovered contents without adding them."),
  Flag.withDefault(false),
);

export const addCliCommand = Command.make(
  "add",
  { source, version, registry, preview, ...localFlags },
  (input) =>
    handleSourceCommand(
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
          return yield* new MissingRequirement({
            command: "add",
            requires: "<source>",
            hint: "A source is `owner/repo`, a Git or GitHub URL, or a local path; `--list` previews it without adding.",
          });
        yield* rejectDedicatedInstallerSourceEffect(selectedSource);
        if (input.preview) {
          const value = yield* renderer.withStatus(
            `Inspecting ${selectedSource}`,
            withSelectedRegistry(previewLibrarySourceEffect(selectedSource, requestedVersion)),
          );
          return yield* renderer.result(result("addPreview", value));
        }
        const retained = yield* renderer.withStatus(
          "Retaining source",
          withSelectedRegistry(retainLibrarySourceEffect(selectedSource, requestedVersion)),
        );
        yield* renderer.result(
          result("add", {
            action: retained.action,
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
            ...("diagnostics" in retained && retained.diagnostics?.length
              ? { diagnostics: retained.diagnostics }
              : {}),
          }),
        );
        const measurement = yield* Effect.gen(function* () {
          const store = yield* LibraryStore;
          const state = yield* store.load;
          const ids = new Set<string>(retained.skill_ids);
          const load = yield* readDescriptionLoad(
            state,
            store.originalsPath,
            state.skills.filter((skill) => ids.has(skill.skill_id)),
          );
          return descriptionLoadMessage(load);
        }).pipe(Effect.orElseSucceed(() => "Description size unavailable."));
        yield* renderer.note(measurement, "Description size");
      }),
    ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
).pipe(
  Command.withDescription("Add a source to the local library without enabling it."),
  Command.withExamples([
    { command: "skit add owner/repository" },
    { command: "skit add skit:owner/package@1.0.0" },
    { command: "skit add ./my-tools --list" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "network.read", "process.execute"],
      subprocesses: [...sourceAcquisitionSubprocesses, ...credentialStoreReadSubprocesses],
    },
    outputSchemas: [outputContracts.add, outputContracts.addPreview],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
