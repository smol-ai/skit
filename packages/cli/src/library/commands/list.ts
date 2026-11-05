import { SkitConfiguration, skitConfigurationLayer } from "@smolai/skit-core";

import { openLibraryView, openLibrarySession } from "@smolai/skit-core/library/session";
import { Option, Effect } from "effect";
import { Command } from "effect/cli";
import { handleLibraryCommand } from "../../commands/handler.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { localFlags } from "../../commands/parameters.js";
import { Renderer } from "../../terminal/renderer.js";
import { result } from "../../commands/result.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { terminalPrompterLayer } from "../../terminal/prompter.js";
import { promptsAllowed } from "../../terminal/interactivity.js";
import { browseLibrary } from "../presentation/browse.js";

export const presentListCommand = Effect.fn("CLI.list.present")(function* () {
  const view = yield* Effect.flatMap(SkitConfiguration, (paths) => openLibraryView(paths.skitHome));
  const subjects = yield* view.readSubjects();
  const value = {
    subjects: subjects.map((subject) => ({
      subject_id: subject.id,
      subject_kind: subject.kind,
      label: subject.label,
      skills: subject.skills.map((skill) => ({
        source: skill.source,
        revision: skill.revision,
        source_updated_at: skill.source_updated_at,
        imported_at: skill.imported_at,
        name: skill.name,
        skill_id: skill.id,
        ...(skill.versionId === undefined ? {} : { selected_skill_version_id: skill.versionId }),
        versions: skill.versions.map((version) => ({
          skill_version_id: version.id,
          artifact_hash: version.hash,
        })),
      })),
    })),
    enabled: view.enabledEverywhere.items,
    enabled_skills: view.enabledEverywhere.skills,
  };
  const renderer = yield* Renderer;
  yield* renderer.result(result("list", value));
});

export const listCliCommand = Command.make("list", localFlags, (input) =>
  Effect.gen(function* () {
    const interactive = promptsAllowed({ json: input.json, needsStdout: true });
    return yield* handleLibraryCommand(
      Effect.gen(function* () {
        if (!interactive) return yield* presentListCommand();
        const configuration = yield* libraryCommandConfiguration(input);
        const session = yield* Effect.flatMap(SkitConfiguration, (paths) =>
          openLibrarySession(paths.skitHome, configuration.pull.installOptions),
        );
        yield* browseLibrary(session, configuration.pull.installOptions).pipe(
          Effect.provide(terminalPrompterLayer),
        );
      }),
    );
  }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
).pipe(
  Command.withDescription(
    "Browse the Skills and Collections in your Library and choose what is enabled.",
  ),
  Command.withExamples([{ command: "skit list" }, { command: "skit list --json" }]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read", "filesystem.write"] },
    outputSchemas: [outputContracts.list],
    exitCodes: [0, 12, 64, 65],
    interactive: true,
  }),
);
