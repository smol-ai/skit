import { skitConfigurationLayer } from "../../configuration/skit-configuration.js";
import { terminalLibraryProgressLayer } from "../../presentation/library-progress.js";
import { Effect, Option } from "effect";
import { spawn } from "node:child_process";
import { Argument, Command, Flag } from "effect/cli";
import { handleSourceCommand } from "../../application.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { jsonRequested, localFlags } from "../../commands/parameters.js";
import { CommandLineInvalid } from "../../commands/runtime.js";
import { Renderer } from "../../presentation/renderer.js";
import { shellQuote } from "../../presentation/shell-quote.js";
import { result } from "../contracts.js";
import {
  planUpdatesEffect,
  updateSubjectsEffect,
  updateExitCode,
} from "../../library-application/update.js";
import {
  prepareProjectionRetention,
  projectionComparisonPaths,
  useSkillVersion,
  ProjectionRetentionMissing,
} from "../../workflows/library/projection-retention.js";

const subject = Argument.String("skit-or-skill").pipe(Argument.optional);
const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Report changes without applying them."),
  Flag.withDefault(false),
);
const fromProjection = Flag.String("from-projection").pipe(
  Flag.withDescription("Retain changed bytes from this Projection ID, Harness, or path."),
  Flag.optional,
);
const diff = Flag.Boolean("diff").pipe(
  Flag.withDescription(
    "Review the Library source and installed copy with a scrollable diff; no changes are applied.",
  ),
  Flag.withDefault(false),
);
const useLibrary = Flag.Boolean("use-library").pipe(
  Flag.withDescription(
    "Replace the reviewed installed copy with the Library version, preserving the old copy in a backup.",
  ),
  Flag.withDefault(false),
);

const useVersion = Flag.String("use-version").pipe(
  Flag.withDescription(
    "Switch the Skill to this Library Version and reinstall its unchanged copies.",
  ),
  Flag.optional,
);

const showDiff = (libraryPath: string, installedPath: string) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolve, reject) => {
        // Git pages on a terminal with the user's pager; redirected output is left unpaged.
        const child = spawn(
          "git",
          [
            "--paginate",
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            libraryPath,
            installedPath,
          ],
          { stdio: "inherit", signal },
        );
        child.once("error", reject);
        child.once("close", (code, terminationSignal) =>
          code === 0 || code === 1 || (process.stdout.isTTY && terminationSignal === "SIGPIPE")
            ? resolve()
            : reject(new Error(`git diff exited ${code ?? terminationSignal}`)),
        );
      }),
    catch: (cause) =>
      new ProjectionRetentionMissing({ message: `Could not show the diff: ${String(cause)}` }),
  });

export const updateCliCommand = Command.make(
  "update",
  { subject, dryRun, fromProjection, diff, useLibrary, useVersion, ...localFlags },
  (input) =>
    handleSourceCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const query = Option.getOrUndefined(input.subject);
        const projectionSelector = Option.getOrUndefined(input.fromProjection);
        if (input.diff && (projectionSelector === undefined || jsonRequested()))
          return yield* new CommandLineInvalid({
            message: "--diff needs --from-projection and cannot be combined with --json",
          });
        if (input.useLibrary && (projectionSelector === undefined || input.diff))
          return yield* new CommandLineInvalid({
            message: "--use-library needs --from-projection; review separately with --diff",
          });
        const versionQuery = Option.getOrUndefined(input.useVersion);
        if (versionQuery !== undefined) {
          if (query === undefined || projectionSelector !== undefined)
            return yield* new CommandLineInvalid({
              message: "--use-version needs a Skill and cannot be combined with --from-projection",
            });
          const changed = yield* renderer.withStatus(
            "Switching the Skill Version",
            useSkillVersion(query, versionQuery, input.dryRun),
          );
          return yield* renderer.result(result("skillVersion", changed));
        }
        if (projectionSelector !== undefined) {
          if (query === undefined)
            return yield* new ProjectionRetentionMissing({
              message: "A Skill is required with --from-projection",
            });
          if (input.diff) {
            const prepared = yield* renderer.withStatus(
              "Inspecting changed Projection bytes",
              prepareProjectionRetention(query, projectionSelector),
            );
            const paths = yield* projectionComparisonPaths(prepared.preview);
            const command = `skit update ${shellQuote(query)} --from-projection ${shellQuote(projectionSelector)}`;
            yield* renderer.note(
              "Library source is on the left; the installed copy is on the right. Agent-generated files and metadata can differ. Press q to exit the pager. No changes will be applied.",
              "Compare copies",
            );
            yield* showDiff(paths.libraryPath, paths.installedPath);
            return yield* renderer.note(
              `No files were changed.\n\nKeep the installed copy: ${command} --dry-run\nUse the Library version: ${command} --use-library --dry-run`,
              "Comparison complete",
            );
          }
          if (input.useLibrary) {
            const prepared = yield* renderer.withStatus(
              "Inspecting the installed copy",
              prepareProjectionRetention(query, projectionSelector),
            );
            const { preview } = prepared;
            const changed = input.dryRun
              ? {
                  skill_id: preview.skill_id,
                  skill_name: preview.skill_name,
                  skill_version_id: preview.previous_skill_version_id,
                  applied: false,
                }
              : yield* renderer.withStatus("Installing the Library version", prepared.useLibrary());
            return yield* renderer.result(result("skillVersion", changed));
          }
          const value = yield* renderer.withStatus(
            input.dryRun
              ? "Inspecting changed Projection bytes"
              : "Retaining changed Projection bytes",
            Effect.gen(function* () {
              const prepared = yield* prepareProjectionRetention(query, projectionSelector);
              return input.dryRun
                ? result("projectionRetentionPlan", prepared.preview)
                : result("projectionRetention", yield* prepared.apply());
            }),
          );
          return yield* renderer.result(value);
        }
        if (input.dryRun) {
          const value = yield* renderer.withStatus(
            "Checking Source observations",
            planUpdatesEffect(query),
          );
          return yield* renderer.result(result("updatePlan", value));
        }
        const configuration = yield* libraryCommandConfiguration(input);
        const value = yield* updateSubjectsEffect({ roots: configuration.inventory }, query).pipe(
          Effect.provide(terminalLibraryProgressLayer),
        );
        yield* renderer.result(result("update", value, updateExitCode(value)));
      }),
    ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
).pipe(
  Command.withDescription("Update sources from their recorded origins."),
  Command.withExamples([
    { command: "skit update --dry-run" },
    { command: "skit update my-skill --from-projection claude-code --dry-run" },
    { command: "skit update my-skill --from-projection agents --diff" },
    { command: "skit update my-skill --from-projection agents --use-library --dry-run" },
    { command: "skit update my-skill --from-projection agents --use-library" },
    { command: "skit update my-skill --use-version skv_01example" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [
      outputContracts.update,
      outputContracts.updatePlan,
      outputContracts.projectionRetention,
      outputContracts.projectionRetentionPlan,
      outputContracts.skillVersion,
    ],
    exitCodes: [0, 1, 11, 12, 64, 65],
    interactive: false,
  }),
);
