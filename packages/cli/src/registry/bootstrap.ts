import { Cause, Effect, Exit, FileSystem, Result, Schedule, Schema, Stream } from "effect";
import { BootstrapApi } from "@smolai/skit-core/api";
import { HttpApiClient } from "effect/http-api";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SecureRandom } from "effect/crypto";
import { Base64Url } from "effect/encoding";
import { platform } from "node:os";
import { resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { RegistryHttp } from "./registry-http.js";
import {
  classifyRegistryApiFailure,
  markRegistryResponseDecoding,
  registryApiFailure,
} from "./api-client.js";
import { Renderer } from "../terminal/renderer.js";

import {
  SECRET_NAME,
  wranglerTargetArgs,
  removeBootstrapSecretInvocation,
  BootstrapOriginInvalid,
  BootstrapConfigInvalid,
  BootstrapExternalFailure,
  BootstrapStatusInvalid,
  BootstrapTimedOut,
  BootstrapCleanupFailed,
  type WranglerTarget,
} from "./bootstrap-failures.js";
export {
  BootstrapConfigInvalid,
  BootstrapExternalFailure,
  BootstrapStatusInvalid,
  BootstrapTimedOut,
  BootstrapCleanupFailed,
  removeBootstrapSecretInvocation,
} from "./bootstrap-failures.js";
export type { WranglerTarget } from "./bootstrap-failures.js";

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
            reason: { _tag: "TimedOut", timeoutMs: 60_000 },
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
      const handle = yield* spawner.spawn(process).pipe(
        Effect.mapError(
          (error) =>
            new BootstrapExternalFailure({
              operation,
              reason: { _tag: "NativeFailure", failure: error },
            }),
        ),
      );
      const [captured, code] = yield* Effect.all(
        [handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (error) =>
            new BootstrapExternalFailure({
              operation,
              reason: { _tag: "NativeFailure", failure: error },
            }),
        ),
      );
      if (code !== 0)
        return yield* new BootstrapExternalFailure({
          operation,
          reason: { _tag: "ProcessFailed", command, exitCode: code, output: captured.trim() },
        });
    }),
  );
}

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
          target,
          reason: { _tag: "ReadFailed", failure: error },
        }),
    ),
  );
  const errors: ParseError[] = [];
  const document = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0)
    return yield* new BootstrapConfigInvalid({ target, reason: { _tag: "JsonInvalid", errors } });
  const config = yield* decodeWranglerConfig(document).pipe(
    Effect.mapError(
      (failure) => new BootstrapConfigInvalid({ target, reason: { _tag: "InvalidData", failure } }),
    ),
  );
  if (target.environment !== undefined) {
    const environment = config.env?.[target.environment];
    if (environment === undefined)
      return yield* new BootstrapConfigInvalid({
        target,
        reason: { _tag: "EnvironmentMissing", environment: target.environment },
      });
    if (environment.vars?.PUBLIC_APP_ORIGIN === undefined)
      return yield* new BootstrapConfigInvalid({
        target,
        reason: { _tag: "OriginMissing", environment: target.environment },
      });
    return environment.vars.PUBLIC_APP_ORIGIN;
  }
  // Which Worker is meant is ambiguous, and the secret must not land on the wrong one.
  if (config.env !== undefined)
    return yield* new BootstrapConfigInvalid({
      target,
      reason: { _tag: "EnvironmentRequired", environments: Object.keys(config.env) },
    });
  if (config.vars?.PUBLIC_APP_ORIGIN === undefined)
    return yield* new BootstrapConfigInvalid({
      target,
      reason: { _tag: "OriginMissing" },
    });
  return config.vars.PUBLIC_APP_ORIGIN;
});

const parseOrigin = (origin: string) =>
  Schema.decodeEffect(Schema.URLFromString)(origin).pipe(
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
        transformResponse: markRegistryResponseDecoding,
        httpClient: transport,
        baseUrl: origin,
      });
      return yield* client.bootstrap.status({}).pipe(
        Effect.map((response) => response.needed),
        Effect.mapError((error) => {
          const classified = classifyRegistryApiFailure(error, [200]);
          if (classified.kind === "transport")
            return new BootstrapExternalFailure({
              operation: "status",
              reason: { _tag: "NativeFailure", failure: classified.error },
            });
          if (classified.kind === "response_decode" || classified.kind === "request_encoding")
            return new BootstrapStatusInvalid({
              origin: origin.origin,
              failure: classified.failure,
            });
          return new BootstrapExternalFailure({
            operation: "status",
            reason: { _tag: "HttpRejected", origin: origin.origin, ...registryApiFailure(error) },
          });
        }),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(
              new BootstrapExternalFailure({
                operation: "status",
                reason: { _tag: "TimedOut", timeoutMs: 10_000 },
              }),
            ),
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
                  orElse: () =>
                    Effect.fail(
                      new BootstrapTimedOut({
                        origin: origin.origin,
                        timeoutMs: options.timeoutMs ?? 10 * 60_000,
                      }),
                    ),
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
          (removed) =>
            Effect.gen(function* () {
              if (Exit.isFailure(removed)) {
                const cleanup = Cause.findError(removed.cause);
                if (Result.isSuccess(cleanup)) {
                  const original = Exit.isFailure(exit) ? Cause.findError(exit.cause) : undefined;
                  return yield* new BootstrapCleanupFailed({
                    target,
                    command: wranglerCommand,
                    cleanup: cleanup.success,
                    ...(original && Result.isSuccess(original)
                      ? { original: original.success }
                      : {}),
                  });
                }
                return yield* Effect.failCause(removed.cause);
              }
              return yield* Exit.isSuccess(exit)
                ? Effect.succeed(exit.value)
                : Effect.failCause(exit.cause);
            }),
        ),
    ),
  );
});
