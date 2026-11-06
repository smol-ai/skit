import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Effect, Option } from "effect";
import { descriptionLoadMessage } from "../library/presentation/description-size.js";
import { addSource, inspectSource } from "@smolai/skit-core/library/source";
import { Argument, Command, Flag } from "effect/cli";
import { handleSourceCommand } from "../application.js";
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
        const request = yield* addSourceRequest(
          input.source,
          Option.getOrUndefined(input.registry),
        );
        if (input.preview) {
          const value = yield* renderer.withStatus(
            `Inspecting ${input.source}`,
            inspectSource(request),
          );
          return yield* renderer.result(result("addPreview", addOutputContracts.addPreview, value));
        }
        const configuration = yield* SkitConfiguration;
        const { added, descriptionLoad } = yield* renderer.withStatus(
          "Adding source",
          addSource(configuration.skitHome, request),
        );
        yield* renderer.result(result("add", addOutputContracts.add, added));
        yield* renderer.note(
          descriptionLoad === undefined
            ? "Description size unavailable."
            : descriptionLoadMessage(descriptionLoad),
          "Description size",
        );
      }),
      input,
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
