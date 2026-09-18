import {
  Cause,
  Clock,
  Context,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Result,
  Schema,
  Stream,
  Option,
} from "effect";
import { Command } from "effect/unstable/cli";
import { BootstrapApi } from "@smolai/skit-core/universal/api";
import { HttpApiClient } from "effect/unstable/httpapi";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { randomBytes } from "node:crypto";
import { platform } from "node:os";
import { resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { isRegistryTransportError, RegistryHttp } from "../registry/registry-http.js";
import {
  isSuccessfulResponseDecodeFailure,
  mapRegistryFailureCause,
  registryApiFailureMessage,
} from "../registry/api-client.js";
import { Renderer } from "../presentation/renderer.js";
import { handleCommand } from "../application.js";
import { CommandMetadata } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { jsonFlag, optionalString } from "../commands/parameters.js";
import { result } from "../handlers/contracts.js";

const SECRET_NAME = "SKIT_BOOTSTRAP_SECRET";

export interface BootstrapResult {
  readonly origin: string;
  readonly setupUrl?: string;
  readonly status: "complete" | "already_complete";
}

export class BootstrapOriginInvalid extends Data.TaggedError("BootstrapOriginInvalid")<{
  readonly origin: string;
}> {
  get message() {
    return `Invalid server origin: ${this.origin}`;
  }
}
export class BootstrapConfigInvalid extends Data.TaggedError("BootstrapConfigInvalid")<{
  readonly message: string;
}> {}
export class BootstrapExternalFailure extends Data.TaggedError("BootstrapExternalFailure")<{
  readonly operation: "install-secret" | "remove-secret" | "open-browser" | "status";
  readonly message: string;
}> {}
export class BootstrapStatusInvalid extends Data.TaggedError("BootstrapStatusInvalid")<{
  readonly message: string;
}> {}
export class BootstrapTimedOut extends Data.TaggedError("BootstrapTimedOut")<{}> {
  readonly message = "Timed out waiting for initial operator setup";
}
export class BootstrapCleanupFailed extends Data.TaggedError("BootstrapCleanupFailed")<{
  readonly configPath: string;
  readonly cleanup: BootstrapExternalFailure;
  readonly original?: BootstrapPrimaryFailure;
}> {
  get message(): string {
    const original: string = this.original ? ` Original error: ${this.original.message}.` : "";
    return `Bootstrap secret cleanup failed: ${this.cleanup.message}.${original} Remove it manually with: wrangler secret delete ${SECRET_NAME} --config ${this.configPath}`;
  }
}

export type BootstrapPrimaryFailure =
  | BootstrapOriginInvalid
  | BootstrapConfigInvalid
  | BootstrapExternalFailure
  | BootstrapStatusInvalid
  | BootstrapTimedOut;
export type BootstrapFailure = BootstrapPrimaryFailure | BootstrapCleanupFailed;

export interface BootstrapOperationsShape {
  createSecret: Effect.Effect<string>;
  installSecret: (
    secret: string,
    configPath: string,
  ) => Effect.Effect<void, BootstrapExternalFailure>;
  removeSecret: (configPath: string) => Effect.Effect<void, BootstrapExternalFailure>;
  openBrowser: (url: URL) => Effect.Effect<void, BootstrapExternalFailure>;
  bootstrapNeeded: (
    origin: URL,
  ) => Effect.Effect<boolean, BootstrapExternalFailure | BootstrapStatusInvalid>;
}

export class BootstrapOperations extends Context.Service<
  BootstrapOperations,
  BootstrapOperationsShape
>()("skit/BootstrapOperations") {}

const externalFailure = (operation: BootstrapExternalFailure["operation"], message: string) =>
  new BootstrapExternalFailure({ operation, message });

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

export const removeBootstrapSecretInvocation = (configPath: string) => ({
  args: ["secret", "delete", SECRET_NAME, "--config", configPath] as const,
  input: "y\n",
});

export function bootstrapOperationsLayer(wranglerCommand = "wrangler") {
  return Layer.effect(
    BootstrapOperations,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const registry = yield* RegistryHttp;
      const renderer = yield* Renderer;
      const wrangler = (
        operation: BootstrapExternalFailure["operation"],
        args: readonly string[],
        input?: string,
      ) => run(spawner, operation, wranglerCommand, args, { input, stdio: "capture" });
      return BootstrapOperations.of({
        createSecret: Effect.sync(() => randomBytes(32).toString("base64url")),
        installSecret: (secret, configPath) =>
          renderer.withStatus(
            "Adding temporary bootstrap secret",
            wrangler(
              "install-secret",
              ["secret", "put", SECRET_NAME, "--config", configPath],
              secret,
            ),
          ),
        removeSecret: (configPath) => {
          const invocation = removeBootstrapSecretInvocation(configPath);
          return renderer.withStatus(
            "Removing temporary bootstrap secret",
            wrangler("remove-secret", invocation.args, invocation.input),
          );
        },
        openBrowser: (url) => {
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
        },
        bootstrapNeeded: (origin) =>
          Effect.scoped(
            Effect.gen(function* () {
              const transport = yield* registry.client;
              const client = yield* HttpApiClient.makeWith(BootstrapApi, {
                httpClient: transport,
                baseUrl: origin,
              });
              return yield* client.bootstrap.status({}).pipe(
                (effect) => mapRegistryFailureCause(effect, (error) => error),
                Effect.map((response) => response.needed),
                Effect.mapError((error) => {
                  if (isRegistryTransportError(error))
                    return externalFailure("status", error.message);
                  if (isSuccessfulResponseDecodeFailure(error, [200]))
                    return new BootstrapStatusInvalid({
                      message: "Bootstrap status response is invalid",
                    });
                  return externalFailure(
                    "status",
                    registryApiFailureMessage("Bootstrap status", error),
                  );
                }),
                Effect.timeoutOrElse({
                  duration: "10 seconds",
                  orElse: () =>
                    Effect.fail(externalFailure("status", "Bootstrap status timed out")),
                }),
              );
            }),
          ),
      });
    }),
  );
}

const WranglerConfig = Schema.Struct({
  vars: Schema.optionalKey(Schema.Struct({ PUBLIC_APP_ORIGIN: Schema.optionalKey(Schema.String) })),
  env: Schema.optionalKey(Schema.Unknown),
});
const decodeWranglerConfig = Schema.decodeUnknownEffect(WranglerConfig);

export const originFromWranglerConfigEffect = Effect.fn("Bootstrap.origin")(function* (
  configPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(configPath).pipe(
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
  if (config.env !== undefined)
    return yield* Effect.fail(
      new BootstrapConfigInvalid({
        message: "Wrangler environments require an explicit --url for server bootstrap",
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

const waitForBootstrapStatus = Effect.fn("Bootstrap.waitForStatus")(function* (
  origin: URL,
  deadline: number,
  pollIntervalMs: number,
) {
  const operations = yield* BootstrapOperations;
  let consecutiveErrors = 0;
  while (true) {
    if ((yield* Clock.currentTimeMillis) >= deadline)
      return yield* Effect.fail(new BootstrapTimedOut());
    const attempt = yield* Effect.result(operations.bootstrapNeeded(origin));
    if (Result.isSuccess(attempt)) return attempt.success;
    if (++consecutiveErrors >= 5) return yield* Effect.fail(attempt.failure);
    yield* Effect.sleep(pollIntervalMs);
  }
});

export const bootstrapServerEffect = Effect.fn("Bootstrap.server")(function* (
  options: {
    readonly configPath?: string;
    readonly origin?: string;
    readonly open?: boolean;
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
  } = {},
) {
  const operations = yield* BootstrapOperations;
  const configPath = resolve(options.configPath ?? "wrangler.jsonc");
  const configuredOrigin = options.origin ?? (yield* originFromWranglerConfigEffect(configPath));
  const origin = yield* parseOrigin(configuredOrigin);
  const secret = yield* operations.createSecret;
  const setupUrl = new URL(`/setup#token=${encodeURIComponent(secret)}`, origin);
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const deadline = (yield* Clock.currentTimeMillis) + (options.timeoutMs ?? 10 * 60_000);

  const provision = Effect.gen(function* () {
    if (!(yield* waitForBootstrapStatus(origin, deadline, pollIntervalMs)))
      return { origin: origin.origin, status: "already_complete" as const };
    if (options.open !== false) yield* operations.openBrowser(setupUrl);
    while (yield* waitForBootstrapStatus(origin, deadline, pollIntervalMs))
      yield* Effect.sleep(pollIntervalMs);
    return { origin: origin.origin, setupUrl: setupUrl.href, status: "complete" as const };
  });

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(operations.installSecret(secret, configPath), () =>
      Effect.flatMap(Effect.exit(restore(provision)), (exit) =>
        Effect.flatMap(
          Effect.exit(operations.removeSecret(configPath)),
          (removed): Effect.Effect<BootstrapResult, BootstrapFailure> => {
            if (Exit.isFailure(removed)) {
              const cleanup = Cause.findError(removed.cause);
              if (Result.isSuccess(cleanup)) {
                const original = Exit.isFailure(exit) ? Cause.findError(exit.cause) : undefined;
                return Effect.fail(
                  new BootstrapCleanupFailed({
                    configPath,
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
    ),
  );
});

const config = optionalString("config", "Use this Wrangler configuration file.");
const url = optionalString("url", "Override PUBLIC_APP_ORIGIN from the Wrangler configuration.");
const wrangler = optionalString("wrangler", "Use this Wrangler executable.");

export const serverBootstrapCliCommand = Command.make(
  "bootstrap",
  { config, url, wrangler, json: jsonFlag },
  ({ config, url, wrangler }) =>
    handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const value = yield* bootstrapServerEffect({
          configPath: Option.getOrUndefined(config),
          origin: Option.getOrUndefined(url),
        });
        yield* renderer.result(
          result("serverBootstrap", outputContracts.serverBootstrap, {
            origin: value.origin,
            status: value.status,
          }),
        );
      }).pipe(Effect.provide(bootstrapOperationsLayer(Option.getOrUndefined(wrangler)))),
    ),
).pipe(
  Command.withDescription("Create the first operator for a deployed skit-server."),
  Command.withExamples([
    { command: "skit server bootstrap" },
    { command: "skit server bootstrap --config wrangler.jsonc" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["network.write", "process.execute", "browser.open"],
      subprocesses: [
        "wrangler secret put SKIT_BOOTSTRAP_SECRET",
        "wrangler secret delete SKIT_BOOTSTRAP_SECRET",
      ],
    },
    outputSchemas: [outputContracts.serverBootstrap],
    exitCodes: [0],
    interactive: true,
  }),
);
