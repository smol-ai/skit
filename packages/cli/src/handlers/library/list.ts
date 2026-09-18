import { LibraryStore } from "@smolai/skit-core";
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

export const shouldBrowseInteractively = (input: {
  readonly json: boolean;
  readonly stdin: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
}): boolean => !input.json && input.stdin && input.stdout && input.stderr;

export const presentListCommand = Effect.fn("CLI.list.present")(function* () {
  const store = yield* LibraryStore;
  const portable = yield* store.load;
  const value = {
    collections: portable.collections.map((collection) => ({
      collection_id: collection.collection_id,
      display_id: collection.display_name,
      skills: portable.skills
        .filter((skill) => skill.collection_id === collection.collection_id)
        .map((skill) => ({
          name: skill.name,
          skill_id: skill.skill_id,
          ...(skill.selected_skill_version_id === undefined
            ? {}
            : { selected_skill_version_id: skill.selected_skill_version_id }),
          versions: skill.versions.map((version) => ({
            skill_version_id: version.skill_version_id,
            artifact_digest: version.artifact_digest,
          })),
        })),
    })),
    bindings: portable.global_bindings.map((binding) => ({
      collection_id: binding.collection_id,
      harness: binding.harness,
      skills: [...binding.skills],
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
          const session = yield* openLibrarySession(yield* configuration.detectedHarnesses);
          yield* browseLibraryEffect(session, configuration.pull.bindings);
        }).pipe(Effect.provide(terminalPrompterLayer))
      : presentListCommand(),
    homePath(input.home),
  );
}).pipe(
  Command.withDescription("Browse retained Collections and manage Skill enablement."),
  Command.withExamples([{ command: "skit list" }, { command: "skit list --json" }]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.list],
    exitCodes: [0, 12, 64, 65],
    interactive: true,
  }),
);
