import { readLibrarySkillMetadata } from "../../workflows/library/skill-metadata.js";
import { bindingSkillIds, currentSkillVersion, LibraryStore } from "@smolai/skit-core";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { handleCommand } from "../../application.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { terminalPrompterLayer } from "../../presentation/prompter.js";
import { browseLibraryEffect } from "../../presentation/interactive-list.js";
import { openLibrarySession } from "../../workflows/library/session.js";
import { librarySubjects } from "../../workflows/library/subject-resolution.js";

export const shouldBrowseInteractively = (input: {
  readonly json: boolean;
  readonly stdin: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
}): boolean => !input.json && input.stdin && input.stdout && input.stderr;

export const presentListCommand = Effect.fn("CLI.list.present")(function* () {
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const metadata = yield* readLibrarySkillMetadata(state, store.originalsPath);
  const value = {
    subjects: librarySubjects(state).map((subject) => ({
      subject_id: subject.subjectId,
      subject_kind: subject.kind,
      label: subject.label,
      skills: subject.skills.map((skill) => {
        const selected = currentSkillVersion(state, skill);
        return {
          ...metadata.get(skill.skill_id)!,
          name: skill.name,
          skill_id: skill.skill_id,
          ...(selected === undefined
            ? {}
            : { selected_skill_version_id: selected.skill_version_id }),
          versions: skill.versions.map((version) => ({
            skill_version_id: version.skill_version_id,
            artifact_digest: version.artifact_digest,
          })),
        };
      }),
    })),
    bindings: state.global_bindings.map((binding) => ({
      scope: binding.scope,
      entries: binding.entries.map((entry) =>
        entry.kind === "collection"
          ? {
              ...entry,
              label:
                state.collections.find(
                  (collection) => collection.collection_id === entry.collection_id,
                )?.label ?? entry.collection_id,
            }
          : {
              ...entry,
              name:
                state.skills.find((skill) => skill.skill_id === entry.skill_id)?.name ??
                entry.skill_id,
            },
      ),
      skills: bindingSkillIds(state, binding),
    })),
  };
  const renderer = yield* Renderer;
  yield* renderer.result(result("list", outputContracts.list, value));
});

export const listCliCommand = Command.make("list", localFlags, (input) => {
  const interactive = shouldBrowseInteractively({
    json: input.json,
    stdin: Boolean(process.stdin.isTTY),
    stdout: Boolean(process.stdout.isTTY),
    stderr: Boolean(process.stderr.isTTY),
  });
  return handleCommand(
    interactive
      ? Effect.gen(function* () {
          const configuration = yield* libraryCommandConfiguration(input);
          const session = yield* openLibrarySession();
          yield* browseLibraryEffect(session, configuration.pull.bindings);
        }).pipe(Effect.provide(terminalPrompterLayer))
      : presentListCommand(),
    homePath(input.home),
  );
}).pipe(
  Command.withDescription("Browse retained Skills and Collections and manage enablement."),
  Command.withExamples([{ command: "skit list" }, { command: "skit list --json" }]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.list],
    exitCodes: [0, 12, 64, 65],
    interactive: true,
  }),
);
