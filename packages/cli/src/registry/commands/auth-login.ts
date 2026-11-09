import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { CommandMetadata, credentialStoreSubprocesses } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { jsonFlag } from "../../commands/parameters.js";
import { Renderer } from "../../terminal/renderer.js";
import { result } from "../../commands/result.js";
import { personReachable, promptsAllowed } from "../../terminal/interactivity.js";
import { authLoginCommand } from "./login.js";

const registry = Argument.String("registry").pipe(Argument.optional);

const relogin = Flag.Boolean("relogin").pipe(
  Flag.withDescription("Replace the saved credential even if it is still valid."),
  Flag.withDefault(false),
);

const alias = Flag.String("as").pipe(
  Flag.withDescription("Name this Registry for device-local routing."),
  Flag.optional,
);

const scopes = Flag.String("scopes").pipe(
  Flag.withDescription("Request comma-separated credential scopes."),
  Flag.map((value) => value.split(",").filter(Boolean)),
  Flag.optional,
);

export const authLoginCliCommand = Command.make(
  "login",
  { registry, alias, scopes, relogin, json: jsonFlag },
  ({ registry, alias, scopes, relogin, json }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      const renderer = yield* Renderer;
      const value = yield* authLoginCommand({
        registry: Option.getOrUndefined(registry),
        alias: Option.getOrUndefined(alias),
        scopes: Option.getOrElse(scopes, () => ["library:sync"]),
        home: selectedHome,
        relogin,
        interactive: promptsAllowed({ json }),
        browserApproval: personReachable(),
      });
      yield* renderer.result(
        "verificationUri" in value ? result("authLoginPending", value) : result("authLogin", value),
      );
    }),
).pipe(
  Command.withDescription(
    "Reuse saved authentication or sign in by approving this login in your browser, and store a CLI credential in the system keychain, or ~/.skit/auth.json without one.",
  ),
  Command.withExamples([
    { command: "skit auth login" },
    { command: "skit auth login private" },
    { command: "skit auth login https://skit.example.com" },
    {
      command: "skit auth login https://skit.example.com --scopes library:sync,authoring:write",
    },
  ]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: [
        "filesystem.read",
        "filesystem.write",
        "network.read",
        "network.write",
        "process.execute",
        "browser.open",
      ],
      subprocesses: [...credentialStoreSubprocesses, "open", "xdg-open"],
    },
    outputSchemas: [outputContracts.authLogin, outputContracts.authLoginPending],
    exitCodes: [0, 11, 12, 64],
    interactive: true,
  }),
);
