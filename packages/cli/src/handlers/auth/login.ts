import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { handleCommand } from "../../application.js";
import { loginEffect, resolveLoginTargetEffect } from "../../registry/auth.js";
import { SelectionCancelled } from "../../presentation/interaction-failures.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, homePath, jsonFlag } from "../../commands/parameters.js";
import { InteractiveLoginUnavailable, ScopesInvalid } from "../../registry/failures.js";
import { Prompter, terminalPrompterLayer } from "../../presentation/prompter.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";

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
  }) {
    if (!options.interactive) return yield* new InteractiveLoginUnavailable();
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

const registry = Argument.string("registry").pipe(Argument.optional);
const alias = Flag.string("as").pipe(
  Flag.withDescription("Name this Registry for device-local routing."),
  Flag.optional,
);
const scopes = Flag.string("scopes").pipe(
  Flag.withDescription("Request comma-separated credential scopes."),
  Flag.map((value) => value.split(",").filter(Boolean)),
  Flag.optional,
);

export const authLoginCliCommand = Command.make(
  "login",
  { registry, alias, scopes, home: homeFlag, json: jsonFlag },
  ({ registry, alias, scopes, home }) => {
    const selectedHome = homePath(home);
    return handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const value = yield* authLoginCommand({
          registry: Option.getOrUndefined(registry),
          alias: Option.getOrUndefined(alias),
          scopes: Option.getOrElse(scopes, () => ["library:sync"]),
          home: selectedHome,
          interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
        });
        yield* renderer.result(result("authLogin", outputContracts.authLogin, value));
      }).pipe(Effect.provide(terminalPrompterLayer)),
      selectedHome,
    );
  },
).pipe(
  Command.withDescription("Sign in and store an expiring CLI credential."),
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
