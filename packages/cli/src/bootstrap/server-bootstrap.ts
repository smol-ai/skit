import { skitConfigurationLayer, FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import {
  Data,
  Cause,
  Effect,
  Exit,
  FileSystem,
  Result,
  Schedule,
  Schema,
  Stream,
  Option,
} from "effect";
import { Command } from "effect/cli";
import { BootstrapApi } from "@smolai/skit-core/universal/api";
import { HttpApiClient } from "effect/http-api";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SecureRandom } from "effect/crypto";
import { Base64Url } from "effect/encoding";
import { platform } from "node:os";
import { resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { isRegistryTransportError, RegistryHttp } from "../registry/registry-http.js";
import {
  isSuccessfulResponseDecodeFailure,
  registryApiFailureMessage,
} from "../registry/api-client.js";
import { Renderer } from "../terminal/renderer.js";
import { handleRegistryCommand } from "../commands/handler.js";
import { CommandMetadata } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { jsonFlag, optionalString } from "../commands/parameters.js";
import { result } from "../commands/result.js";

const SECRET_NAME = "SKIT_BOOTSTRAP_SECRET";

/** The Worker a Wrangler command acts on: a config file and, optionally, one of its environments. */
export interface WranglerTarget {
  readonly configPath: string;
  readonly environment?: string;
}

const wranglerTargetArgs = (target: WranglerTarget) => [
  "--config",
  target.configPath,
  ...(target.environment === undefined ? [] : ["--env", target.environment]),
];

export interface BootstrapResult {
  readonly origin: string;
  readonly setupUrl?: string;
  readonly status: "complete" | "already_complete";
}

class BootstrapOriginInvalid
  extends Data.TaggedError("BootstrapOriginInvalid")<{
    readonly origin: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Pass --url as the server's full https:// origin.";
  get message() {
    return `Invalid server origin: ${this.origin}`;
  }
}
export class BootstrapConfigInvalid
  extends Data.TaggedError("BootstrapConfigInvalid")<{
    readonly message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Correct the Wrangler configuration passed with --config, then retry.";
}
export class BootstrapExternalFailure
  extends Data.TaggedError("BootstrapExternalFailure")<{
    readonly operation: "install-secret" | "remove-secret" | "open-browser" | "status";
    readonly message: string;
    readonly timedOut?: boolean;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get remediation(): string {
    return this.timedOut
      ? "Check network connectivity and Cloudflare service status before retrying setup."
      : "Check that Wrangler is installed and signed in, then retry.";
  }
}
export class BootstrapStatusInvalid
  extends Data.TaggedError("BootstrapStatusInvalid")<{
    readonly message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check that --url names a SKIT server, then retry.";
}
export class BootstrapTimedOut
  extends Data.TaggedError("BootstrapTimedOut")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation =
    "Finish operator setup in the browser, then run `skit server bootstrap` again.";
  readonly message = "Timed out waiting for initial operator setup";
}
export class BootstrapCleanupFailed
  extends Data.TaggedError("BootstrapCleanupFailed")<{
    readonly target: WranglerTarget;
    readonly cleanup: BootstrapExternalFailure;
    readonly original?: BootstrapPrimaryFailure;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get remediation(): string {
    return this.original?._tag === "BootstrapExternalFailure" &&
      this.original.operation === "install-secret"
      ? `${this.original.remediation} If the secret was installed, remove it with the command above.`
      : "Remove the bootstrap secret with the wrangler command above.";
  }
  get message(): string {
    if (
      this.original?._tag === "BootstrapExternalFailure" &&
      this.original.operation === "install-secret"
    )
      return `Bootstrap secret installation failed: ${this.original.message}. Cleanup could not be confirmed: ${this.cleanup.message}. If the secret was installed, remove it manually with: wrangler secret delete ${SECRET_NAME} ${wranglerTargetArgs(this.target).join(" ")}`;
    const original: string = this.original ? ` Original error: ${this.original.message}.` : "";
    return `Bootstrap secret cleanup failed: ${this.cleanup.message}.${original} Remove it manually with: wrangler secret delete ${SECRET_NAME} ${wranglerTargetArgs(this.target).join(" ")}`;
  }
}

export type BootstrapPrimaryFailure =
  | BootstrapOriginInvalid
  | BootstrapConfigInvalid
  | BootstrapExternalFailure
  | BootstrapStatusInvalid
  | BootstrapTimedOut;
export type BootstrapFailure = BootstrapPrimaryFailure | BootstrapCleanupFailed;

const externalFailure = (operation: BootstrapExternalFailure["operation"], message: string) =>
  new BootstrapExternalFailure({ operation, message });

// Mask external cancellation while changing the secret, but race the action against its
// own timer. The process finalizer also needs forceKillAfter: the race waits for cleanup.
const secretOperation = (
  operation: "install-secret" | "remove-secret",
  action: Effect.Effect<void, BootstrapExternalFailure>,
) =>
  action.pipe(
    Effect.timeoutOrElse({
      duration: "1 minute",
      orElse: () =>
        Effect.fail(
          new BootstrapExternalFailure({
            operation,
            message: `${operation} timed out after 1 minute`,
            timedOut: true,
          }),
        ),
    }),
  );

function run(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  operation: BootstrapExternalFailure["operation"],
  command: string,
  args: readonly string[],
  options: { readonly input?: string; readonly stdio?: "capture" | "ignore" | "inherit" } = {},
) {
  const output = options.stdio ?? "inherit";
  const process = ChildProcess.make(command, [...args], {
    shell: platform() === "win32",
    forceKillAfter: "5 seconds",
    stdin:
      options.input === undefined
        ? output === "capture"
          ? "ignore"
          : output
        : Stream.fromIterable([new TextEncoder().encode(options.input)]),
    stdout: output === "capture" ? "pipe" : output,
    stderr: output === "capture" ? "pipe" : output,
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(process)
        .pipe(Effect.mapError((error) => externalFailure(operation, error.message)));
      const [captured, code] = yield* Effect.all(
        [handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError((error) => externalFailure(operation, error.message)));
      if (code !== 0)
        return yield* Effect.fail(
          externalFailure(
            operation,
            `${command} exited with status ${code}${captured.trim() ? `: ${captured.trim()}` : ""}`,
          ),
        );
    }),
  );
}

export const removeBootstrapSecretInvocation = (target: WranglerTarget) => ({
  args: ["secret", "delete", SECRET_NAME, ...wranglerTargetArgs(target)],
  input: "y\n",
});

const WranglerVars = Schema.optionalKey(
  Schema.Struct({ PUBLIC_APP_ORIGIN: Schema.optionalKey(Schema.String) }),
);
const WranglerConfig = Schema.Struct({
  vars: WranglerVars,
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ vars: WranglerVars }))),
});
const decodeWranglerConfig = Schema.decodeUnknownEffect(WranglerConfig);

export const originFromWranglerConfig = Effect.fn("Bootstrap.origin")(function* (
  target: WranglerTarget,
) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(target.configPath).pipe(
    Effect.mapError(
      (error) =>
        new BootstrapConfigInvalid({
          message: `Unable to read Wrangler config: ${error.message}`,
        }),
    ),
  );
  const errors: ParseError[] = [];
  const document = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0)
    return yield* Effect.fail(
      new BootstrapConfigInvalid({ message: "Wrangler config is invalid" }),
    );
  const config = yield* decodeWranglerConfig(document).pipe(
    Effect.mapError(() => new BootstrapConfigInvalid({ message: "Wrangler config is invalid" })),
  );
  if (target.environment !== undefined) {
    const environment = config.env?.[target.environment];
    if (environment === undefined)
      return yield* new BootstrapConfigInvalid({
        message: `The Wrangler config has no env.${target.environment}`,
      });
    if (environment.vars?.PUBLIC_APP_ORIGIN === undefined)
      return yield* new BootstrapConfigInvalid({
        message: `PUBLIC_APP_ORIGIN is missing from env.${target.environment}.vars; pass --url explicitly`,
      });
    return environment.vars.PUBLIC_APP_ORIGIN;
  }
  // Which Worker is meant is ambiguous, and the secret must not land on the wrong one.
  if (config.env !== undefined)
    return yield* Effect.fail(
      new BootstrapConfigInvalid({
        message:
          "The Wrangler config has environments; pass --env <name>, or --url to bootstrap the top-level Worker",
      }),
    );
  if (config.vars?.PUBLIC_APP_ORIGIN === undefined)
    return yield* Effect.fail(
      new BootstrapConfigInvalid({
        message: "PUBLIC_APP_ORIGIN is missing from the Wrangler config; pass --url explicitly",
      }),
    );
  return config.vars.PUBLIC_APP_ORIGIN;
});

const parseOrigin = (origin: string) =>
  Schema.decodeUnknownEffect(Schema.URLFromString)(origin).pipe(
    Effect.mapError(() => new BootstrapOriginInvalid({ origin })),
  );

export const bootstrapServer = Effect.fn("Bootstrap.server")(function* (
  options: {
    readonly configPath?: string;
    readonly environment?: string;
    readonly origin?: string;
    readonly open?: boolean;
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
    readonly wrangler?: string;
  } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const registry = yield* RegistryHttp;
  const renderer = yield* Renderer;
  const random = yield* SecureRandom.SecureRandom;
  const wranglerCommand = options.wrangler ?? "wrangler";
  const wrangler = (
    operation: BootstrapExternalFailure["operation"],
    args: readonly string[],
    input?: string,
  ) => run(spawner, operation, wranglerCommand, args, { input, stdio: "capture" });
  const installSecret = (secret: string, target: WranglerTarget) =>
    renderer.withStatus(
      "Adding temporary bootstrap secret",
      wrangler(
        "install-secret",
        ["secret", "put", SECRET_NAME, ...wranglerTargetArgs(target)],
        secret,
      ),
    );
  const removeSecret = (target: WranglerTarget) => {
    const invocation = removeBootstrapSecretInvocation(target);
    return renderer.withStatus(
      "Removing temporary bootstrap secret",
      wrangler("remove-secret", invocation.args, invocation.input),
    );
  };
  const openBrowser = (url: URL) => {
    if (platform() === "darwin")
      return renderer.withStatus(
        `Opening browser at ${url.origin}`,
        run(spawner, "open-browser", "open", [url.href], { stdio: "ignore" }),
      );
    if (platform() === "win32")
      return renderer.withStatus(
        `Opening browser at ${url.origin}`,
        run(spawner, "open-browser", "cmd", ["/c", "start", "", url.href], {
          stdio: "ignore",
        }),
      );
    return renderer.withStatus(
      `Opening browser at ${url.origin}`,
      run(spawner, "open-browser", "xdg-open", [url.href], { stdio: "ignore" }),
    );
  };

  const target: WranglerTarget = {
    configPath: resolve(options.configPath ?? "wrangler.jsonc"),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  };
  const configuredOrigin = options.origin ?? (yield* originFromWranglerConfig(target));
  const origin = yield* parseOrigin(configuredOrigin);
  const secret = Base64Url.encode(yield* random.randomBytes(32));
  const setupUrl = new URL(`/setup#token=${encodeURIComponent(secret)}`, origin);
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const bootstrapNeeded = Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* registry.client;
      const client = yield* HttpApiClient.makeWith(BootstrapApi, {
        httpClient: transport,
        baseUrl: origin,
      });
      return yield* client.bootstrap.status({}).pipe(
        Effect.map((response) => response.needed),
        Effect.mapError((error) => {
          if (isRegistryTransportError(error)) return externalFailure("status", error.message);
          if (isSuccessfulResponseDecodeFailure(error, [200]))
            return new BootstrapStatusInvalid({
              message: "Bootstrap status response is invalid",
            });
          return externalFailure("status", registryApiFailureMessage("Bootstrap status", error));
        }),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(externalFailure("status", "Bootstrap status timed out")),
        }),
      );
    }),
  );
  const waitForBootstrapStatus = bootstrapNeeded.pipe(
    Effect.retry({
      times: 4,
      schedule: Schedule.spaced(pollIntervalMs),
      while: (error) => error._tag === "BootstrapExternalFailure",
    }),
    Effect.withSpan("Bootstrap.waitForStatus"),
  );

  const provision = Effect.gen(function* () {
    if (!(yield* waitForBootstrapStatus))
      return { origin: origin.origin, status: "already_complete" as const };
    if (options.open !== false) yield* openBrowser(setupUrl);
    yield* waitForBootstrapStatus.pipe(
      Effect.repeat({ schedule: Schedule.spaced(pollIntervalMs), while: (needed) => needed }),
    );
    return { origin: origin.origin, setupUrl: setupUrl.href, status: "complete" as const };
  });

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(
      Effect.exit(
        secretOperation("install-secret", installSecret(secret, target)).pipe(
          Effect.andThen(
            restore(
              provision.pipe(
                Effect.timeoutOrElse({
                  duration: options.timeoutMs ?? 10 * 60_000,
                  orElse: () => Effect.fail(new BootstrapTimedOut()),
                }),
              ),
            ),
          ),
        ),
      ),
      (exit) =>
        Effect.flatMap(
          // Even a failed install may have reached Cloudflare before Wrangler failed locally.
          Effect.exit(secretOperation("remove-secret", removeSecret(target))),
          (removed): Effect.Effect<BootstrapResult, BootstrapFailure> => {
            if (Exit.isFailure(removed)) {
              const cleanup = Cause.findError(removed.cause);
              if (Result.isSuccess(cleanup)) {
                const original = Exit.isFailure(exit) ? Cause.findError(exit.cause) : undefined;
                return Effect.fail(
                  new BootstrapCleanupFailed({
                    target,
                    cleanup: cleanup.success,
                    ...(original && Result.isSuccess(original)
                      ? { original: original.success }
                      : {}),
                  }),
                );
              }
              return Effect.failCause(removed.cause);
            }
            return Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause);
          },
        ),
    ),
  );
});

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
