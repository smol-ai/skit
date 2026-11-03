import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Redacted, Sink, Stream } from "effect";
import { SecureRandom } from "effect/crypto";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { NodeFileSystem } from "@effect/platform-node";
import { skitLayer } from "@smolai/skit-core";
import { renderContract } from "../src/presentation/contract-presenters.js";
import { consoleRendererLayer } from "../src/presentation/renderer.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { result } from "../src/handlers/contracts.js";
import {
  BootstrapCleanupFailed,
  BootstrapConfigInvalid,
  BootstrapExternalFailure,
  BootstrapStatusInvalid,
  BootstrapTimedOut,
  bootstrapServer,
  originFromWranglerConfig,
  removeBootstrapSecretInvocation,
} from "../src/bootstrap/server-bootstrap.js";

// 32 bytes of 0x01, base64url-encoded without padding.
const SECRET = `${"AQEB".repeat(10)}AQE`;

type ProcessKind = "install" | "remove" | "open";
interface ProcessExit {
  readonly code: number;
  readonly output?: string;
}
/** A status reply: `needed`, an HTTP error status, an undecodable 200, or a custom response. */
type StatusReply =
  | boolean
  | number
  | "invalid"
  | Effect.Effect<HttpClientResponse.HttpClientResponse>;

function bootstrapFixture(statuses: Array<StatusReply>) {
  const spawned: Array<{
    readonly kind: ProcessKind;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin: string;
  }> = [];
  const statusUrls: string[] = [];
  const processes: Partial<Record<ProcessKind, Effect.Effect<ProcessExit>>> = {};
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
      const args = command.args.map((arg) => (typeof arg === "string" ? arg : Redacted.value(arg)));
      const kind: ProcessKind =
        args[0] !== "secret" ? "open" : args[1] === "put" ? "install" : "remove";
      const input = command.options.stdin;
      const stdin = Stream.isStream(input)
        ? yield* input.pipe(Stream.decodeText(), Stream.mkString)
        : "";
      spawned.push({ kind, command: command.command, args, stdin });
      const exit = yield* processes[kind] ?? exited(0);
      const output = Stream.fromIterable(
        exit.output === undefined ? [] : [new TextEncoder().encode(exit.output)],
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exit.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: output,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const http = HttpClient.make((request) => {
    statusUrls.push(request.url);
    const reply = statuses.shift() ?? false;
    if (Effect.isEffect(reply)) return reply;
    const response =
      typeof reply === "boolean"
        ? Response.json({ needed: reply })
        : reply === "invalid"
          ? Response.json({})
          : new Response(null, { status: reply });
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const layer = Layer.mergeAll(
    NodeFileSystem.layer,
    consoleRendererLayer(true),
    registryHttpLayer(Layer.succeed(HttpClient.HttpClient)(http)),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner),
    Layer.succeed(SecureRandom.SecureRandom)(
      SecureRandom.make((size) => new Uint8Array(size).fill(1)),
    ),
  );
  const of = (kind: ProcessKind) => spawned.filter((process) => process.kind === kind);
  return {
    processes,
    layer,
    statusUrls,
    installs: () => of("install"),
    removals: () => of("remove"),
    opens: () => of("open"),
    statusChecks: () => statusUrls.length,
  };
}

const exited = (code: number, output?: string): Effect.Effect<ProcessExit> =>
  Effect.succeed(output === undefined ? { code } : { code, output });

const stalledUntilInterrupted = (onInterrupt: () => void) =>
  Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(onInterrupt)));

describe("server bootstrap journey", () => {
  it("hands completed setup off to login", () => {
    assert.strictEqual(
      renderContract(
        result("serverBootstrap", { origin: "https://skit.example", status: "complete" }),
        { color: false, detail: "summary" },
      ),
      "Server setup complete at https://skit.example\nIf email verification is enabled, follow the browser result. If delivery failed, use Resend on the sign-in page.\nNext: skit auth login https://skit.example",
    );
  });

  it("confirms bootstrap secret deletion non-interactively", () => {
    assert.deepStrictEqual(
      removeBootstrapSecretInvocation({ configPath: "/server/wrangler.jsonc" }),
      {
        args: ["secret", "delete", "SKIT_BOOTSTRAP_SECRET", "--config", "/server/wrangler.jsonc"],
        input: "y\n",
      },
    );
  });

  it("deletes the bootstrap secret from the selected Wrangler environment's Worker", () => {
    assert.deepStrictEqual(
      removeBootstrapSecretInvocation({ configPath: "/server/wrangler.jsonc", environment: "test" })
        .args,
      [
        "secret",
        "delete",
        "SKIT_BOOTSTRAP_SECRET",
        "--config",
        "/server/wrangler.jsonc",
        "--env",
        "test",
      ],
    );
  });

  it.effect("owns installation, setup, polling and cleanup", () => {
    const fixture = bootstrapFixture([true, false]);
    return Effect.gen(function* () {
      const result = yield* bootstrapServer({
        configPath: "./wrangler.jsonc",
        origin: "https://skit.example",
        pollIntervalMs: 0,
      });
      const setupUrl = `https://skit.example/setup#token=${SECRET}`;
      assert.deepStrictEqual(result, {
        origin: "https://skit.example",
        setupUrl,
        status: "complete",
      });
      assert.strictEqual(fixture.installs().length, 1);
      assert.strictEqual(fixture.installs()[0]?.stdin, SECRET);
      assert.deepStrictEqual(
        fixture.opens().map((open) => open.args.at(-1)),
        [setupUrl],
      );
      assert.deepStrictEqual(fixture.statusUrls, [
        "https://skit.example/api/bootstrap/status",
        "https://skit.example/api/bootstrap/status",
      ]);
      assert.strictEqual(fixture.removals().length, 1);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("adds and removes the secret on the selected environment's Worker", () => {
    const fixture = bootstrapFixture([false]);
    return Effect.gen(function* () {
      yield* bootstrapServer({
        configPath: "/server/wrangler.jsonc",
        environment: "test",
        origin: "https://skit-test.example",
        wrangler: "/opt/bin/wrangler",
      });
      const target = { configPath: "/server/wrangler.jsonc", environment: "test" };
      const removal = removeBootstrapSecretInvocation(target);
      assert.deepStrictEqual(
        fixture.installs().map(({ command, args }) => ({ command, args })),
        [
          {
            command: "/opt/bin/wrangler",
            args: [
              "secret",
              "put",
              "SKIT_BOOTSTRAP_SECRET",
              "--config",
              "/server/wrangler.jsonc",
              "--env",
              "test",
            ],
          },
        ],
      );
      assert.deepStrictEqual(
        fixture.removals().map(({ command, args, stdin }) => ({ command, args, stdin })),
        [{ command: "/opt/bin/wrangler", args: removal.args, stdin: removal.input }],
      );
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("reports an existing claim without opening setup", () => {
    const fixture = bootstrapFixture([false]);
    return Effect.gen(function* () {
      const result = yield* bootstrapServer({
        configPath: "./wrangler.jsonc",
        origin: "https://skit.example",
      });
      assert.deepStrictEqual(result, {
        origin: "https://skit.example",
        status: "already_complete",
      });
      assert.lengthOf(fixture.opens(), 0);
      assert.lengthOf(fixture.removals(), 1);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("retries transient status failures", () => {
    const fixture = bootstrapFixture([404, 502, true, false]);
    return Effect.gen(function* () {
      const result = yield* bootstrapServer({
        origin: "https://skit.example",
        pollIntervalMs: 0,
      });
      assert.strictEqual(result.status, "complete");
      assert.strictEqual(fixture.statusChecks(), 4);
      assert.lengthOf(fixture.removals(), 1);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("cleans up when setup fails", () => {
    const fixture = bootstrapFixture([true]);
    fixture.processes.open = exited(1);
    return bootstrapServer({ origin: "https://skit.example" }).pipe(
      Effect.provide(fixture.layer),
      Effect.flip,
      Effect.map((actual) => {
        assert.instanceOf(actual, BootstrapExternalFailure);
        assert.strictEqual(actual.operation, "open-browser");
        assert.match(actual.message, /exited with status 1$/);
        assert.lengthOf(fixture.removals(), 1);
      }),
    );
  });

  it.effect("rejects an invalid status response without retrying", () => {
    const fixture = bootstrapFixture(["invalid", false]);
    return bootstrapServer({ origin: "https://skit.example" }).pipe(
      Effect.provide(fixture.layer),
      Effect.flip,
      Effect.map((failure) => {
        assert.instanceOf(failure, BootstrapStatusInvalid);
        assert.strictEqual(fixture.statusChecks(), 1);
        assert.lengthOf(fixture.opens(), 0);
        assert.lengthOf(fixture.removals(), 1);
      }),
    );
  });

  it.effect("stops after five failed status attempts and preserves the last failure", () =>
    Effect.gen(function* () {
      const fixture = bootstrapFixture([500, 501, 502, 503, 504, false]);
      const fiber = yield* bootstrapServer({
        origin: "https://skit.example",
        pollIntervalMs: 1_000,
      }).pipe(Effect.provide(fixture.layer), Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(4_000);
      const failure = yield* Fiber.join(fiber);
      assert.instanceOf(failure, BootstrapExternalFailure);
      assert.strictEqual(failure.operation, "status");
      assert.match(failure.message, /\(504\)/);
      assert.strictEqual(fixture.statusChecks(), 5);
      assert.lengthOf(fixture.removals(), 1);
    }),
  );

  for (const phase of ["status", "browser", "poll-delay"] as const) {
    it.effect(`enforces the setup deadline during ${phase} and finishes cleanup afterwards`, () =>
      Effect.gen(function* () {
        const cleanupStarted = yield* Deferred.make<void>();
        const finishCleanup = yield* Deferred.make<void>();
        let interrupted = false;
        const stalled = stalledUntilInterrupted(() => {
          interrupted = true;
        });
        const fixture = bootstrapFixture(phase === "status" ? [stalled] : [true, true, false]);
        if (phase === "browser") fixture.processes.open = stalled;
        fixture.processes.remove = Deferred.succeed(cleanupStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishCleanup)),
          Effect.andThen(exited(0)),
        );
        const fiber = yield* bootstrapServer({
          origin: "https://skit.example",
          timeoutMs: 100,
          pollIntervalMs: 1_000,
        }).pipe(Effect.provide(fixture.layer), Effect.flip, Effect.forkChild);
        yield* TestClock.adjust(100);
        yield* Deferred.await(cleanupStarted);
        // Cleanup has its own budget and must not be cut off by the setup deadline.
        yield* TestClock.adjust(500);
        yield* Deferred.succeed(finishCleanup, undefined);
        assert.instanceOf(yield* Fiber.join(fiber), BootstrapTimedOut);
        if (phase !== "poll-delay") assert.isTrue(interrupted);
        if (phase === "poll-delay") assert.strictEqual(fixture.statusChecks(), 2);
      }),
    );
  }

  it.effect("cleans up an unsuccessful secret installation without starting setup", () => {
    const fixture = bootstrapFixture([]);
    fixture.processes.install = exited(1, "Wrangler lost its connection after writing the secret");
    return bootstrapServer({ origin: "https://skit.example" }).pipe(
      Effect.provide(fixture.layer),
      Effect.flip,
      Effect.map((actual) => {
        assert.instanceOf(actual, BootstrapExternalFailure);
        assert.strictEqual(actual.operation, "install-secret");
        assert.match(actual.message, /Wrangler lost its connection after writing the secret$/);
        assert.strictEqual(fixture.statusChecks(), 0);
        assert.lengthOf(fixture.removals(), 1);
      }),
    );
  });

  for (const operation of ["install-secret", "remove-secret"] as const) {
    it.effect(`bounds a stalled ${operation} and interrupts the operation`, () =>
      Effect.gen(function* () {
        const fixture = bootstrapFixture([false]);
        let interrupted = false;
        const stalled = stalledUntilInterrupted(() => {
          interrupted = true;
        });
        if (operation === "install-secret") fixture.processes.install = stalled;
        else fixture.processes.remove = stalled;
        const fiber = yield* bootstrapServer({ origin: "https://skit.example" }).pipe(
          Effect.provide(fixture.layer),
          Effect.flip,
          Effect.forkChild,
        );
        yield* TestClock.adjust("1 minute");
        const failure = yield* Fiber.join(fiber);
        assert.isTrue(interrupted);
        if (operation === "install-secret") {
          assert.instanceOf(failure, BootstrapExternalFailure);
          assert.strictEqual(failure.operation, operation);
          assert.match(failure.remediation, /network connectivity and Cloudflare service status/);
          assert.strictEqual(fixture.statusChecks(), 0);
          assert.lengthOf(fixture.removals(), 1);
        } else {
          assert.instanceOf(failure, BootstrapCleanupFailed);
          assert.strictEqual(failure.cleanup.operation, operation);
          assert.match(
            failure.cleanup.remediation,
            /network connectivity and Cloudflare service status/,
          );
          assert.match(failure.message, /wrangler secret delete SKIT_BOOTSTRAP_SECRET/);
        }
      }),
    );
  }

  it.effect(
    "keeps the installation diagnosis and remediation first when cleanup also fails",
    () => {
      const fixture = bootstrapFixture([]);
      fixture.processes.install = exited(1, "Not logged in");
      fixture.processes.remove = exited(1, "Not logged in");
      return bootstrapServer({ origin: "https://skit.example" }).pipe(
        Effect.provide(fixture.layer),
        Effect.flip,
        Effect.map((failure) => {
          assert.instanceOf(failure, BootstrapCleanupFailed);
          assert.instanceOf(failure.original, BootstrapExternalFailure);
          assert.strictEqual(failure.original.operation, "install-secret");
          assert.strictEqual(failure.cleanup.operation, "remove-secret");
          assert.strictEqual(
            failure.cleanup.message,
            "wrangler exited with status 1: Not logged in",
          );
          assert.match(
            failure.message,
            /^Bootstrap secret installation failed: wrangler exited with status 1: Not logged in/,
          );
          assert.match(failure.message, /If the secret was installed/);
          assert.match(failure.remediation, /^Check that Wrangler is installed and signed in/);
          assert.strictEqual(fixture.statusChecks(), 0);
        }),
      );
    },
  );

  it.effect("holds external cancellation during installation until its own timer expires", () =>
    Effect.gen(function* () {
      const fixture = bootstrapFixture([]);
      const installing = yield* Deferred.make<void>();
      let interrupted = false;
      fixture.processes.install = Deferred.succeed(installing, undefined).pipe(
        Effect.andThen(
          stalledUntilInterrupted(() => {
            interrupted = true;
          }),
        ),
      );
      const fiber = yield* bootstrapServer({ origin: "https://skit.example" }).pipe(
        Effect.provide(fixture.layer),
        Effect.forkChild,
      );
      yield* Deferred.await(installing);
      const cancellation = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* TestClock.adjust("59 seconds");
      assert.isFalse(interrupted);
      assert.isUndefined(fiber.pollUnsafe());
      assert.lengthOf(fixture.removals(), 0);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(cancellation);
      assert.isTrue(interrupted);
      assert.lengthOf(fixture.removals(), 1);
    }),
  );

  it.effect("bounds secret cleanup even when the workflow has already been cancelled", () =>
    Effect.gen(function* () {
      const polling = yield* Deferred.make<void>();
      const removing = yield* Deferred.make<void>();
      let cleanupInterrupted = false;
      const fixture = bootstrapFixture([
        Deferred.succeed(polling, undefined).pipe(Effect.andThen(Effect.never)),
      ]);
      fixture.processes.remove = Deferred.succeed(removing, undefined).pipe(
        Effect.andThen(
          stalledUntilInterrupted(() => {
            cleanupInterrupted = true;
          }),
        ),
      );
      const fiber = yield* bootstrapServer({ origin: "https://skit.example" }).pipe(
        Effect.provide(fixture.layer),
        Effect.forkChild,
      );
      yield* Deferred.await(polling);
      const cancellation = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* Deferred.await(removing);
      yield* TestClock.adjust("59 seconds");
      assert.isFalse(cleanupInterrupted);
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(cancellation);
      assert.isTrue(cleanupInterrupted);
    }),
  );

  it.effect("reports cleanup remediation with the original typed failure", () => {
    const fixture = bootstrapFixture([true]);
    fixture.processes.open = exited(1);
    fixture.processes.remove = exited(1, "Cloudflare unavailable");
    return bootstrapServer({ origin: "https://skit.example" }).pipe(
      Effect.provide(fixture.layer),
      Effect.flip,
      Effect.map((failure) => {
        assert.instanceOf(failure, BootstrapCleanupFailed);
        assert.instanceOf(failure.original, BootstrapExternalFailure);
        assert.strictEqual(failure.original.operation, "open-browser");
        assert.match(failure.message, /wrangler secret delete SKIT_BOOTSTRAP_SECRET/);
      }),
    );
  });

  it.effect("removes the secret when the workflow is interrupted", () =>
    Effect.gen(function* () {
      const polling = yield* Deferred.make<void>();
      const fixture = bootstrapFixture([
        true,
        Deferred.succeed(polling, undefined).pipe(Effect.andThen(Effect.never)),
      ]);
      const fiber = yield* bootstrapServer({
        origin: "https://skit.example",
        pollIntervalMs: 0,
      }).pipe(Effect.provide(fixture.layer), Effect.forkChild);
      yield* Deferred.await(polling);
      yield* Fiber.interrupt(fiber);
      assert.lengthOf(fixture.removals(), 1);
    }),
  );

  it.effect("decodes the top-level JSONC origin and refuses to guess between environments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-bootstrap-config-" });
        const config = `${root}/wrangler.jsonc`;
        yield* fs.writeFileString(
          config,
          `{ // "PUBLIC_APP_ORIGIN": "https://wrong.example"
          "vars": { "PUBLIC_APP_ORIGIN": "https://right.example", },
        }`,
        );
        assert.strictEqual(
          yield* originFromWranglerConfig({ configPath: config }),
          "https://right.example",
        );
        yield* fs.writeFileString(
          config,
          `{ "vars": { "PUBLIC_APP_ORIGIN": "https://right.example" }, "env": { "production": {} } }`,
        );
        const failure = yield* Effect.flip(originFromWranglerConfig({ configPath: config }));
        assert.instanceOf(failure, BootstrapConfigInvalid);
        assert.match(failure.message, /--env <name>/);
      }),
    ).pipe(Effect.provide(skitLayer)),
  );

  it.effect("reads the selected environment's origin, never the top level's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-bootstrap-config-" });
        const config = `${root}/wrangler.jsonc`;
        yield* fs.writeFileString(
          config,
          `{
            "vars": { "PUBLIC_APP_ORIGIN": "https://production.example" },
            "env": {
              "test": { "vars": { "PUBLIC_APP_ORIGIN": "https://test.example" } },
              "bare": {},
            },
          }`,
        );
        assert.strictEqual(
          yield* originFromWranglerConfig({ configPath: config, environment: "test" }),
          "https://test.example",
        );
        const missingOrigin = yield* Effect.flip(
          originFromWranglerConfig({ configPath: config, environment: "bare" }),
        );
        assert.match(missingOrigin.message, /env\.bare\.vars/);
        const missingEnvironment = yield* Effect.flip(
          originFromWranglerConfig({ configPath: config, environment: "staging" }),
        );
        assert.match(missingEnvironment.message, /no env\.staging/);
      }),
    ).pipe(Effect.provide(skitLayer)),
  );
});
