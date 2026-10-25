import {
  SkitConfiguration,
  skitConfigurationLayer,
} from "../../configuration/skit-configuration.js";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { handleRegistryCommand } from "../../application.js";
import { loginEffect, resolveLoginTargetEffect, reuseLoginEffect } from "../../registry/auth.js";
import { SelectionCancelled } from "../../presentation/interaction-failures.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, jsonFlag, jsonRequested } from "../../commands/parameters.js";
import { InteractiveLoginUnavailable, ScopesInvalid } from "../../registry/failures.js";
import { Prompter, terminalPrompterLayer } from "../../presentation/prompter.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";
import { promptsAllowed } from "../../presentation/interactivity.js";

const AuthScopes = Schema.Array(
  Schema.Literals(["library:sync", "authoring:write", "publication:write"]),
);

export const authLoginCommand = Effect.fn("CLI.authLogin")(
  function* (options: {
    readonly registry?: string;
    readonly alias?: string;
    readonly scopes: readonly string[];
    readonly home?: string;
    readonly interactive: boolean;
    readonly relogin?: boolean;
  }) {
    const scopes = yield* Schema.decodeUnknownEffect(AuthScopes)(options.scopes).pipe(
      Effect.mapError(
        () =>
          new ScopesInvalid({
            allowed: ["library:sync", "authoring:write", "publication:write"],
          }),
      ),
    );
    if (scopes.length === 0)
      return yield* new ScopesInvalid({
        allowed: ["library:sync", "authoring:write", "publication:write"],
      });
    const origin = yield* resolveLoginTargetEffect(options.registry, options.home);
    if (!options.relogin) {
      const existing = yield* Effect.scoped(
        reuseLoginEffect({
          origin,
          scopes,
          alias: options.alias,
          home: options.home,
        }),
      );
      if (existing) return existing;
    }
    if (!options.interactive) return yield* new InteractiveLoginUnavailable();
    const prompter = yield* Prompter;
    const email = yield* prompter.text("Email");
    const password = yield* prompter.password("Password");
    const renderer = yield* Renderer;
    return yield* renderer.withStatus(
      "Signing in",
      Effect.scoped(
        loginEffect({
          origin,
          email,
          password,
          scopes: [...scopes],
          alias: options.alias,
          home: options.home,
        }),
      ),
    );
  },
  Effect.catchTag("PromptCancelled", () => new SelectionCancelled({ subject: "Login" })),
);

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
  { registry, alias, scopes, relogin, home: homeFlag, json: jsonFlag },
  ({ registry, alias, scopes, relogin, home }) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      return yield* handleRegistryCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const value = yield* authLoginCommand({
            registry: Option.getOrUndefined(registry),
            alias: Option.getOrUndefined(alias),
            scopes: Option.getOrElse(scopes, () => ["library:sync"]),
            home: selectedHome,
            relogin,
            interactive: promptsAllowed({ json: jsonRequested() }),
          });
          yield* renderer.result(result("authLogin", value));
        }).pipe(Effect.provide(terminalPrompterLayer)),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(home)))),
).pipe(
  Command.withDescription(
    "Reuse saved authentication or sign in and store a CLI credential in the system keychain, or ~/.skit/auth.json without one.",
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
    effects: { capabilities: ["network.write", "filesystem.write"] },
    outputSchemas: [outputContracts.authLogin],
    exitCodes: [0, 11, 12, 64],
    interactive: true,
  }),
);
