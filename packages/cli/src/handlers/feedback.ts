import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { handlePlatformCommand } from "../application.js";
import { CommandMetadata, credentialStoreReadSubprocesses } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { homeFlag, jsonFlag, optionalString } from "../commands/parameters.js";
import { SkitConfiguration, skitConfigurationLayer } from "../configuration/skit-configuration.js";
import {
  feedbackInput,
  feedbackOrigin,
  feedbackSigningToken,
  sendFeedback,
} from "../feedback/send.js";
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
    signedIn: Flag.Boolean("signed-in").pipe(
      Flag.withDescription(
        "Attribute the report to the account this machine is signed in to. Only with the user's agreement.",
      ),
      Flag.withDefault(false),
    ),
    email: optionalString(
      "email",
      "A contact address for a reply. Only one the user gave you for this report.",
    ),
    home: homeFlag,
    json: jsonFlag,
  },
  (options) =>
    Effect.gen(function* () {
      const { skitHome } = yield* SkitConfiguration;
      return yield* handlePlatformCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const input = yield* feedbackInput({
            text: Option.getOrUndefined(options.text),
            message: Option.getOrUndefined(options.message),
            harness: Option.getOrUndefined(options.harness),
            model: Option.getOrUndefined(options.model),
            email: Option.getOrUndefined(options.email),
          });
          const recipient = yield* feedbackOrigin;
          const token = options.signedIn
            ? yield* feedbackSigningToken(recipient, skitHome)
            : undefined;
          const sent = yield* sendFeedback(recipient, input, token);
          yield* renderer.result(
            result("feedbackSend", {
              ...sent,
              recipient,
              signedIn: options.signedIn,
              ...(input.email === undefined ? {} : { email: input.email }),
            }),
          );
        }).pipe(Effect.provide(registryHttpLayer())),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(options.home)))),
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
    {
      command:
        'skit feedback send "skit sync --json gave no reason for base_mismatch" --signed-in --email ada@example.com',
    },
  ]),
  Command.annotate(CommandMetadata, {
    stability: "experimental",
    effects: {
      capabilities: ["network.write", "filesystem.read", "process.execute"],
      subprocesses: credentialStoreReadSubprocesses,
    },
    outputSchemas: [outputContracts.feedbackSend],
    exitCodes: [0, 1, 13, 64],
    interactive: false,
  }),
);
