import {
  SkitConfiguration,
  skitConfigurationLayer,
} from "../../configuration/skit-configuration.js";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { handleRegistryCommand } from "../../application.js";
import {
  clearPendingLogin,
  loginEffect,
  type PendingDeviceLogin,
  readPendingLogin,
  resolveLoginTargetEffect,
  reuseLoginEffect,
  savePendingLogin,
  startDeviceLoginEffect,
} from "../../registry/auth.js";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SelectionCancelled } from "../../presentation/interaction-failures.js";
import { CommandMetadata, credentialStoreSubprocesses } from "../../commands/metadata.js";
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

// The Registry accepts the code with or without the separator; it only aids reading.
const displayUserCode = (userCode: string) =>
  /^[A-Z0-9]{8}$/u.test(userCode) ? `${userCode.slice(0, 4)}-${userCode.slice(4)}` : userCode;

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
    const announce = (pending: PendingDeviceLogin) =>
      Effect.gen(function* () {
        yield* renderer.instruction(
          `Open ${pending.verificationUri}\nand enter the code ${displayUserCode(pending.userCode)}.`,
          "Approve this login in your browser",
        );
        yield* renderer.updateStatus("Waiting for approval in the browser");
        if (options.interactive)
          yield* openInBrowser(pending.verificationUri).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
      });
    const login = (
      method: { email?: string; password?: string; pending?: PendingDeviceLogin } = {},
    ) =>
      renderer.withStatus(
        "Signing in",
        Effect.scoped(
          loginEffect({
            origin,
            ...method,
            onDeviceCode: announce,
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

    const pending = yield* readPendingLogin(origin, options.home);
    if (pending)
      return yield* login({ pending }).pipe(
        Effect.tap(() => clearPendingLogin(options.home)),
        Effect.catchTag("DeviceLoginEnded", (ended) =>
          clearPendingLogin(options.home).pipe(Effect.andThen(Effect.fail(ended))),
        ),
      );
    if (options.interactive)
      return yield* login().pipe(
        Effect.catchTag("DeviceLoginUnavailable", () => promptForPassword),
      );
    // An agent's user sees its command's output only once the command ends, so start the login,
    // hand back the code, and leave waiting for approval to the next run.
    const started = yield* startDeviceLoginEffect({ origin, scopes }).pipe(
      Effect.catchTag("DeviceLoginUnavailable", () => new InteractiveLoginUnavailable()),
    );
    yield* savePendingLogin(started, options.home);
    return {
      origin,
      userCode: displayUserCode(started.userCode),
      verificationUri: started.verificationUri,
      expiresAt: started.expiresAt,
      next: options.registry ? `skit auth login ${options.registry}` : "skit auth login",
    };
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
          yield* renderer.result(
            "verificationUri" in value
              ? result("authLoginPending", value)
              : result("authLogin", value),
          );
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
