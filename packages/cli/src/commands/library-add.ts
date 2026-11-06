import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Effect, Option } from "effect";
import { descriptionLoadMessage } from "../library/presentation/description-size.js";
import { readLibraryDescriptionLoad } from "@smolai/skit-core/library/queries";
import { Argument, Command, Flag } from "effect/cli";
import { handleSourceCommand } from "../application.js";
import { MissingRequirement } from "./input-failures.js";
import {
  CommandMetadata,
  credentialStoreReadSubprocesses,
  sourceFetchSubprocesses,
} from "./metadata.js";
import { addOutputContracts, rejectDedicatedInstallerSource } from "../library/add.js";
import { localFlags, optionalString } from "./parameters.js";
import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "./encode-result.js";
import { Registry, type ResolvedAuth } from "../registry/index.js";
import { importSource, previewLibrarySource } from "../library/source.js";

const source = Argument.String("source");

const registry = optionalString("registry", "Resolve a Registry source through a name or URL.");

const preview = Flag.Boolean("list").pipe(
  Flag.withDescription("Preview discovered contents without adding them."),
  Flag.withDefault(false),
);

export const addCliCommand = Command.make(
  "add",
  { source, registry, preview, ...localFlags },
  (input) =>
    handleSourceCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const locator = input.source
          ? yield* Registry.source(input.source, {
              registry: Option.getOrUndefined(input.registry),
            })
          : undefined;
        const selectedRegistry: ResolvedAuth | undefined = locator?.origin
          ? {
              origin: locator.origin,
              token: locator.token,
              source: locator.token === undefined ? "none" : "stored",
            }
          : undefined;
        const selectedSource = locator?.input ?? input.source;
        if (!selectedSource)
          return yield* new MissingRequirement({
            command: "add",
            requires: "<source>",
            hint: "A source is `owner/repo`, a Git or GitHub URL, or a local path; `--list` previews it without adding.",
          });
        yield* rejectDedicatedInstallerSource(selectedSource);
        if (input.preview) {
          const value = yield* renderer.withStatus(
            `Inspecting ${selectedSource}`,
            previewLibrarySource(selectedSource, selectedRegistry),
          );
          return yield* renderer.result(result("addPreview", addOutputContracts.addPreview, value));
        }
        const imported = yield* renderer.withStatus(
          "Retaining source",
          importSource(selectedSource, undefined, selectedRegistry),
        );
        yield* renderer.result(
          result("add", addOutputContracts.add, {
            action: imported.action,
            ...(imported.collection_id === undefined
              ? {}
              : { collection_id: imported.collection_id }),
            skill_ids: imported.skill_ids,
            collection_version_id: imported.collection_version_id,
            snapshot_digest: imported.snapshot_digest,
            skills: imported.skills.map((skill) => ({
              name: skill.name,
              verbatim_path: skill.verbatim_path,
            })),
            ...("diagnostics" in imported && imported.diagnostics?.length
              ? { diagnostics: imported.diagnostics }
              : {}),
          }),
        );
        const measurement = yield* Effect.gen(function* () {
          const configuration = yield* SkitConfiguration;
          const load = yield* readLibraryDescriptionLoad(configuration.skitHome, {
            skills: imported.skill_ids,
          });
          return descriptionLoadMessage(load);
        }).pipe(Effect.orElseSucceed(() => "Description size unavailable."));
        yield* renderer.note(measurement, "Description size");
      }),
      Option.getOrUndefined(input.home),
    ),
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
      subprocesses: [...sourceFetchSubprocesses, ...credentialStoreReadSubprocesses],
    },
    outputSchemas: [addOutputContracts.add, addOutputContracts.addPreview],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
