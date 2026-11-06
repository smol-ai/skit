import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import { Effect, Option } from "effect";
import { Command } from "effect/cli";
import { bootstrapServer } from "../bootstrap.js";
import { Renderer } from "../../terminal/renderer.js";
import { handleRegistryCommand } from "../../commands/handler.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { jsonFlag, optionalString } from "../../commands/parameters.js";
import { result } from "../../commands/result.js";

const config = optionalString("config", "Use this Wrangler configuration file.");
const url = optionalString("url", "Override PUBLIC_APP_ORIGIN from the Wrangler configuration.");
const environment = optionalString(
  "env",
  "Bootstrap this environment of the Wrangler configuration, reading its PUBLIC_APP_ORIGIN.",
);
const wrangler = optionalString("wrangler", "Use this Wrangler executable.");

export const serverBootstrapCliCommand = Command.make(
  "bootstrap",
  { config, env: environment, url, wrangler, json: jsonFlag },
  ({ config, env, url, wrangler }) =>
    handleRegistryCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const value = yield* bootstrapServer({
          configPath: Option.getOrUndefined(config),
          environment: Option.getOrUndefined(env),
          origin: Option.getOrUndefined(url),
          wrangler: Option.getOrUndefined(wrangler),
        });
        yield* renderer.result(
          result("serverBootstrap", {
            origin: value.origin,
            status: value.status,
          }),
        );
      }),
    ).pipe(Effect.provide(skitConfigurationLayer())),
).pipe(
  Command.withDescription("Create the first operator for a deployed skit-server."),
  Command.withExamples([
    { command: "skit server bootstrap" },
    { command: "skit server bootstrap --config wrangler.jsonc" },
    { command: "skit server bootstrap --config wrangler.jsonc --env test" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: [
        "filesystem.read",
        "network.read",
        "network.write",
        "process.execute",
        "browser.open",
      ],
      subprocesses: [
        "wrangler secret put SKIT_BOOTSTRAP_SECRET",
        "wrangler secret delete SKIT_BOOTSTRAP_SECRET",
      ],
    },
    outputSchemas: [outputContracts.serverBootstrap],
    exitCodes: [0, 64],
    interactive: true,
  }),
);
