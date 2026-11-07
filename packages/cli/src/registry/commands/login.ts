import { Effect, Schema } from "effect";

import { Registry, type PendingDeviceLogin } from "../index.js";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SelectionCancelled } from "../../terminal/interaction-failures.js";
import { InteractiveLoginUnavailable, ScopesInvalid } from "../failures.js";
import { Prompter } from "../../terminal/prompter.js";
import { Renderer } from "../../terminal/renderer.js";

/** Open `url` in the user's browser with the platform's standard opener; best effort. */
const openInBrowser = (url: string) => {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(command!, args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
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
    const origin = yield* Registry.loginTarget(options.registry, options.home);
    if (!options.relogin) {
      const existing = yield* Effect.scoped(
        Registry.reuseLogin({
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
        // Polling starts without waiting: an opener such as xdg-open may run the browser in the
        // foreground and return only when it closes.
        if (options.interactive)
          yield* Effect.forkChild(
            openInBrowser(pending.verificationUri).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          );
      });
    const login = (
      method: { email: string; password: string } | { approvedSessionToken: string },
    ) =>
      Effect.scoped(
        Registry.login({
          origin,
          ...method,
          scopes: [...scopes],
          alias: options.alias,
          home: options.home,
        }),
      );
    /** Show the code, wait for approval outside the configuration writer, then mint and store. */
    const deviceLogin = (pending: PendingDeviceLogin) =>
      renderer.withStatus(
        "Signing in",
        Effect.gen(function* () {
          yield* announce(pending);
          return yield* Registry.completeDeviceLogin({
            pending,
            scopes,
            alias: options.alias,
            home: options.home,
          });
        }),
      );
    const promptForPassword = Effect.gen(function* () {
      if (!options.interactive) return yield* new InteractiveLoginUnavailable();
      const prompter = yield* Prompter;
      const email = yield* prompter.text("Email");
      const password = yield* prompter.password("Password");
      return yield* renderer.withStatus("Signing in", login({ email, password }));
    });
    if (!(options.browserApproval ?? options.interactive)) return yield* promptForPassword;

    const prepared = yield* Registry.prepareDeviceLogin({
      origin,
      scopes,
      home: options.home,
      relogin: options.relogin,
    }).pipe(
      Effect.catchTag("DeviceLoginUnavailable", () =>
        options.interactive ? promptForPassword : new InteractiveLoginUnavailable(),
      ),
    );
    // Password fallback is already complete; a prepared browser login is ready to show or resume.
    if (!("pending" in prepared)) return prepared;
    const { pending: started, resumed } = prepared;
    if (resumed || options.interactive) return yield* deviceLogin(started);
    // An agent sees the code once this command ends; its next run resumes through the owner.
    return {
      origin,
      userCode: displayUserCode(started.userCode),
      verificationUri: started.verificationUri,
      expiresAt: started.expiresAt,
      // The next process has no access to this invocation's options. Preserve the complete
      // request, including its home, and pin the resolved origin rather than a mutable alias.
      next: [
        "skit",
        "auth",
        "login",
        origin,
        "--scopes",
        scopes.join(","),
        ...(options.alias === undefined ? [] : ["--as", options.alias]),
        ...(options.home === undefined ? [] : ["--home", options.home]),
      ]
        .map((word) =>
          /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`,
        )
        .join(" "),
    };
  },
  Effect.catchTag("PromptCancelled", () => new SelectionCancelled({ subject: "Login" })),
);
