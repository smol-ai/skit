import { LibraryStore } from "@smolai/skit-core";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { handleCommand } from "../../application.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { executePortableRemoveEffect } from "../../workflows/library/portable-remove.js";
import {
  readAuthorWorkspaceEffect,
  writeAuthorWorkspaceEffect,
} from "../../library/author-workspace.js";
import { result } from "../contracts.js";

const subject = Argument.string("skit-or-skill");
const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Report removals without applying them."),
  Flag.withDefault(false),
);

export const removeCliCommand = Command.make(
  "remove",
  { subject, dryRun, ...localFlags },
  (input) =>
    handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const configuration = yield* libraryCommandConfiguration(input);
        const store = yield* LibraryStore;
        const portable = yield* store.load;
        const outcome = yield* renderer.withStatus(
          input.dryRun ? "Planning Collection removal" : "Removing retained Collection",
          executePortableRemoveEffect(portable, {
            query: input.subject,
            dryRun: input.dryRun,
            variantsPath: configuration.pull.bindings.variantsPath,
          }),
        );
        if (outcome.kind === "plan")
          return yield* renderer.result(
            result("remove", outputContracts.removePlan, outcome.value),
          );
        const removed =
          outcome.value.subject_kind === "collection"
            ? portable.collections.find(
                (collection) => collection.collection_id === outcome.value.subject_id,
              )
            : undefined;
        if (removed?.upstream?.source_identity.kind === "authored-workspace") {
          const acquisitionIds = new Set(
            portable.skills
              .filter((skill) => skill.collection_id === removed.collection_id)
              .flatMap((skill) =>
                skill.versions.flatMap((version) =>
                  version.origins.map((origin) => origin.acquisition_id),
                ),
              ),
          );
          const workspacePath = portable.acquisitions.find(
            (acquisition) =>
              acquisitionIds.has(acquisition.acquisition_id) &&
              acquisition.source_identity.kind === "authored-workspace",
          )?.input.value;
          const workspace =
            workspacePath === undefined
              ? undefined
              : yield* readAuthorWorkspaceEffect(workspacePath);
          if (workspace?.workspace_id === removed.upstream.source_identity.workspace_id)
            yield* writeAuthorWorkspaceEffect(workspacePath!, {
              ...workspace,
              registration: "removed",
            });
        }
        yield* renderer.result(result("remove", outputContracts.remove, outcome.value));
      }),
      homePath(input.home),
    ),
).pipe(
  Command.withDescription("Remove a retained Collection and its owned Projections."),
  Command.withExamples([{ command: "skit remove owner/tools --dry-run" }]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.remove, outputContracts.removePlan],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
