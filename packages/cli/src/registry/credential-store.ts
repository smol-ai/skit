import { Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Where a stored Registry token lives. `keychain` is macOS Keychain through `/usr/bin/security`,
 * `secret-service` is the Linux desktop secret store through `secret-tool`. A token in neither is
 * kept in auth.json with mode 0600, as on machines without a usable store.
 */
export type TokenStorage = "keychain" | "secret-service";

/** The OS store this machine offers, unless the environment chooses the credential file. */
export const osTokenStorage = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TokenStorage | undefined => {
  const choice = env.SKIT_CREDENTIAL_STORE;
  if (choice === "file") return undefined;
  if (choice === "keychain" || choice === "secret-service") return choice;
  return platform === "darwin" ? "keychain" : platform === "linux" ? "secret-service" : undefined;
};

/** Store items are keyed by credential file and origin, so separate SKIT homes never collide. */
const service = (authPath: string) => `skit (${authPath})`;

// `security -i` reads its command from stdin, keeping the token out of the process list. Its
// tokenizer honours double quotes; refuse anything that would need escaping rather than escape it.
const quotable = (value: string) => /^[^"\\\n\r]*$/u.test(value);

const run = Effect.fn("CredentialStore.run")(function* (
  command: string,
  args: readonly string[],
  input?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          forceKillAfter: "5 seconds",
          stdin:
            input === undefined ? "ignore" : Stream.fromIterable([new TextEncoder().encode(input)]),
          stdout: "pipe",
          stderr: "ignore",
        }),
      );
      const [stdout, code] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { stdout, code };
    }),
  ).pipe(
    // A locked keyring can leave `secret-tool` waiting on an unlock prompt nobody will answer;
    // past this the store counts as unreachable, as a missing one does.
    Effect.timeout("10 seconds"),
  );
});

/** The token stored for `origin`, if the store holds one and can be reached. */
export const readStoredToken = Effect.fn("CredentialStore.read")(function* (
  storage: TokenStorage,
  authPath: string,
  origin: string,
) {
  const result = yield* Effect.option(
    storage === "keychain"
      ? run("/usr/bin/security", [
          "find-generic-password",
          "-s",
          service(authPath),
          "-a",
          origin,
          "-w",
        ])
      : run("secret-tool", ["lookup", "service", service(authPath), "account", origin]),
  );
  if (Option.isNone(result) || result.value.code !== 0) return undefined;
  const token = result.value.stdout.replace(/\r?\n$/u, "");
  return token === "" ? undefined : token;
});

/** Store `token` for `origin`; false when the store is missing, locked or refuses the item. */
export const writeStoredToken = Effect.fn("CredentialStore.write")(function* (
  storage: TokenStorage,
  authPath: string,
  origin: string,
  token: string,
) {
  if (storage === "keychain") {
    if (![service(authPath), origin, token].every(quotable)) return false;
    const result = yield* Effect.option(
      run(
        "/usr/bin/security",
        ["-i"],
        `add-generic-password -U -s "${service(authPath)}" -a "${origin}" -w "${token}"\n`,
      ),
    );
    return Option.isSome(result) && result.value.code === 0;
  }
  const result = yield* Effect.option(
    run(
      "secret-tool",
      [
        "store",
        `--label=SKIT Registry token for ${origin}`,
        "service",
        service(authPath),
        "account",
        origin,
      ],
      token,
    ),
  );
  return Option.isSome(result) && result.value.code === 0;
});

/** Remove the token stored for `origin`. A store that cannot be reached holds nothing to remove. */
export const removeStoredToken = Effect.fn("CredentialStore.remove")(function* (
  storage: TokenStorage,
  authPath: string,
  origin: string,
) {
  yield* Effect.ignore(
    storage === "keychain"
      ? run("/usr/bin/security", ["delete-generic-password", "-s", service(authPath), "-a", origin])
      : run("secret-tool", ["clear", "service", service(authPath), "account", origin]),
  );
});
