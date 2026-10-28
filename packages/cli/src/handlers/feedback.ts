import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { handlePlatformCommand } from "../application.js";
import { CommandMetadata } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { jsonFlag, optionalString } from "../commands/parameters.js";
import { feedbackInput, feedbackOrigin, sendFeedback } from "../feedback/send.js";
import { Renderer } from "../presentation/renderer.js";
import { registryHttpLayer } from "../registry/registry-http.js";
import { result } from "./contracts.js";

const text = Argument.String("message").pipe(
  Argument.withDescription("What surprised you or slowed you down."),
  Argument.optional,
);

export const feedbackSendCliCommand = Command.make(
  "send",
  {
    text,
    message: optionalString("message", "The same as the argument; easier to build from a script."),
    harness: optionalString(
      "harness",
      "The agent harness you run in, for example claude-code or codex.",
    ),
    model: optionalString("model", "The model you are, for example claude-opus-5-5."),
    json: jsonFlag,
  },
  (options) =>
    handlePlatformCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const input = yield* feedbackInput({
          text: Option.getOrUndefined(options.text),
          message: Option.getOrUndefined(options.message),
          harness: Option.getOrUndefined(options.harness),
          model: Option.getOrUndefined(options.model),
        });
        const recipient = yield* feedbackOrigin;
        const sent = yield* sendFeedback(recipient, input);
        yield* renderer.result(result("feedbackSend", { ...sent, recipient }));
      }).pipe(Effect.provide(registryHttpLayer())),
    ),
).pipe(
  Command.withDescription(
    "Tell SKIT's maintainers about friction with SKIT itself: an unclear error, a gap in the docs, a step that took longer than it should.",
  ),
  Command.withExamples([
    { command: 'skit feedback send "skit add said the Source was invalid but not which part"' },
    {
      command:
        'skit feedback send --message "setup --json had no field for skipped skills" --harness codex --model gpt-5.5',
    },
  ]),
  Command.annotate(CommandMetadata, {
    stability: "experimental",
    effects: { capabilities: ["network.write"] },
    outputSchemas: [outputContracts.feedbackSend],
    exitCodes: [0, 1, 64],
    interactive: false,
  }),
);
