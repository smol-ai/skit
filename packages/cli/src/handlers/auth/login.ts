import {
  SkitConfiguration,
  skitConfigurationLayer,
} from "../../configuration/skit-configuration.js";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { handleRegistryCommand } from "../../application.js";
import {
  type DeviceApproval,
  loginEffect,
  resolveLoginTargetEffect,
  reuseLoginEffect,
} from "../../registry/auth.js";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SelectionCancelled } from "../../presentation/interaction-failures.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, jsonFlag, jsonRequested } from "../../commands/parameters.js";
import { InteractiveLoginUnavailable, ScopesInvalid } from "../../registry/failures.js";
import { Prompter, terminalPrompterLayer } from "../../presentation/prompter.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";
import { personReachable, promptsAllowed } from "../../presentation/interactivity.js";

/** Open `url` in the user's browser where the platform has a standard opener; best effort. */
const openInBrowser = (url: string) => {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (opener === undefined) return Effect.void;
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(opener, [url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
    );
    yield* handle.exitCode;
  }).pipe(Effect.scoped, Effect.ignore);
};

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
    /** Whether a person can approve the login in a browser; defaults to `interactive`. */
    readonly browserApproval?: boolean;
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
    const renderer = yield* Renderer;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const onDeviceCode = (approval: DeviceApproval) =>
      Effect.gen(function* () {
        yield* renderer.instruction(
          `Open ${approval.verificationUriComplete}\nand check that it shows ${
            // The Registry accepts the code with or without the separator; it only aids reading.
            /^[A-Z0-9]{8}$/u.test(approval.userCode)
              ? `${approval.userCode.slice(0, 4)}-${approval.userCode.slice(4)}`
              : approval.userCode
          }.`,
          "Approve this login in your browser",
        );
        yield* renderer.updateStatus("Waiting for approval in the browser");
        if (options.interactive)
          yield* openInBrowser(approval.verificationUriComplete).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
      });
    const login = (credentials?: { readonly email: string; readonly password: string }) =>
      renderer.withStatus(
        "Signing in",
        Effect.scoped(
          loginEffect({
            origin,
            ...credentials,
            onDeviceCode,
            scopes: [...scopes],
            alias: options.alias,
            home: options.home,
          }),
        ),
      );
    const promptForPassword = Effect.gen(function* () {
      if (!options.interactive) return yield* new InteractiveLoginUnavailable();
      const prompter = yield* Prompter;
      const email = yield* prompter.text("Email");
      const password = yield* prompter.password("Password");
      return yield* login({ email, password });
    });
    if (!(options.browserApproval ?? options.interactive)) return yield* promptForPassword;
    return yield* login().pipe(Effect.catchTag("DeviceLoginUnavailable", () => promptForPassword));
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
            browserApproval: personReachable(),
          });
          yield* renderer.result(result("authLogin", value));
        }).pipe(Effect.provide(terminalPrompterLayer)),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(home)))),
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
    effects: { capabilities: ["network.write", "filesystem.write"] },
    outputSchemas: [outputContracts.authLogin],
    exitCodes: [0, 11, 12, 64],
    interactive: true,
  }),
);
