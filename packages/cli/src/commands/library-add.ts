import { Block } from "../terminal/blocks.js";
import { defineCommand } from "./definition.js";
import * as Library from "@smolai/skit-core/library";
import { Effect } from "effect";
import { descriptionLoadMessage } from "../library/presentation/description-size.js";
import { inspectSource } from "@smolai/skit-core/library/source";
import { Argument, Command, Flag } from "effect/cli";

import {
  CommandMetadata,
  credentialStoreReadSubprocesses,
  sourceFetchSubprocesses,
} from "./metadata.js";
import { addOutputContracts } from "../library/add/output.js";
import { localFlags, optionalString } from "./parameters.js";
import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "./encode-result.js";
import { addSourceRequest } from "../registry/library-source.js";

const source = Argument.String("source").pipe(
  Argument.withDescription("Source path, Git URL, or Registry collection to add to the Library."),
);

const registry = optionalString("registry", "Resolve a Registry source through a name or URL.");

const preview = Flag.Boolean("list").pipe(
  Flag.withDescription("Preview discovered contents without adding them."),
  Flag.withDefault(false),
);

export const addCliCommand = defineCommand(
  "add",
  { source, registry, preview, ...localFlags },
  (input) =>
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const request = yield* addSourceRequest(input.source, input.registry);
      if (input.preview) {
        const value = yield* renderer.withStatus(
          `Inspecting ${input.source}`,
          inspectSource(request),
        );
        return yield* renderer.result(result("addPreview", addOutputContracts.addPreview, value));
      }
      const library = yield* Library.Service;
      const { added, descriptionLoad } = yield* renderer.withStatus(
        "Adding source",
        library.addSource(request),
      );
      yield* renderer.result(result("add", addOutputContracts.add, added));
      yield* renderer.note(
        [
          Block.Note({
            text: [
              descriptionLoad === undefined
                ? "Description size unavailable."
                : descriptionLoadMessage(descriptionLoad),
            ],
          }),
        ],
        "Description size",
      );
    }),
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
    interactive: false,
  }),
);
