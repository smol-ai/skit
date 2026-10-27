import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";
import { skitLayer } from "@smolai/skit-core";
import { renderContract } from "../src/presentation/contract-presenters.js";
import { result } from "../src/handlers/contracts.js";
import {
  BootstrapCleanupFailed,
  BootstrapConfigInvalid,
  BootstrapExternalFailure,
  BootstrapOperations,
  BootstrapStatusInvalid,
  BootstrapTimedOut,
  bootstrapServer,
  originFromWranglerConfig,
  removeBootstrapSecretInvocation,
  type BootstrapOperationsShape,
} from "../src/bootstrap/server-bootstrap.js";

function operations(statuses: Array<boolean | BootstrapExternalFailure | BootstrapStatusInvalid>) {
  const observed: {
    installedSecret?: string;
    openedUrl?: string;
    secretRemoved: boolean;
    statusChecks: number;
  } = { secretRemoved: false, statusChecks: 0 };
  const value: BootstrapOperationsShape = {
    createSecret: Effect.succeed("one-time-secret"),
    installSecret: (secret) =>
      Effect.sync(() => {
        observed.installedSecret = secret;
      }),
    removeSecret: () =>
      Effect.sync(() => {
        observed.secretRemoved = true;
      }),
    openBrowser: (url) =>
      Effect.sync(() => {
        observed.openedUrl = url.href;
      }),
    bootstrapNeeded: () =>
      Effect.suspend(() => {
        observed.statusChecks++;
        const status = statuses.shift() ?? false;
        return typeof status === "boolean" ? Effect.succeed(status) : Effect.fail(status);
      }),
  };
  return {
    observed,
    value,
    layer: Layer.succeed(BootstrapOperations)(BootstrapOperations.of(value)),
  };
}

const statusFailure = (message: string) =>
  new BootstrapExternalFailure({ operation: "status", message });

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
    assert.deepStrictEqual(removeBootstrapSecretInvocation("/server/wrangler.jsonc"), {
      args: ["secret", "delete", "SKIT_BOOTSTRAP_SECRET", "--config", "/server/wrangler.jsonc"],
      input: "y\n",
    });
  });

  it.effect("owns installation, setup, polling and cleanup", () => {
    const { observed, layer } = operations([true, false]);
    return Effect.gen(function* () {
      const result = yield* bootstrapServer({
        configPath: "./wrangler.jsonc",
        origin: "https://skit.example",
        pollIntervalMs: 0,
      });
      assert.deepStrictEqual(result, {
        origin: "https://skit.example",
        setupUrl: "https://skit.example/setup#token=one-time-secret",
        status: "complete",
      });
      assert.strictEqual(observed.installedSecret, "one-time-secret");
      assert.strictEqual(observed.openedUrl, "https://skit.example/setup#token=one-time-secret");
      assert.strictEqual(observed.statusChecks, 2);
      assert.isTrue(observed.secretRemoved);
    }).pipe(Effect.provide(Layer.merge(layer, skitLayer)));
  });

  it.effect("reports an existing claim without opening setup", () => {
    const { observed, layer } = operations([false]);
    return Effect.gen(function* () {
      const result = yield* bootstrapServer({
        configPath: "./wrangler.jsonc",
        origin: "https://skit.example",
      });
      assert.deepStrictEqual(result, {
        origin: "https://skit.example",
        status: "already_complete",
      });
      assert.isUndefined(observed.openedUrl);
      assert.isTrue(observed.secretRemoved);
    }).pipe(Effect.provide(Layer.merge(layer, skitLayer)));
  });

  it.effect("retries transient status failures", () => {
    const { observed, layer } = operations([
      statusFailure("HTTP 404"),
      statusFailure("HTTP 502"),
      true,
      false,
    ]);
    return Effect.gen(function* () {
      const result = yield* bootstrapServer({
        origin: "https://skit.example",
        pollIntervalMs: 0,
      });
      assert.strictEqual(result.status, "complete");
      assert.strictEqual(observed.statusChecks, 4);
      assert.isTrue(observed.secretRemoved);
    }).pipe(Effect.provide(Layer.merge(layer, skitLayer)));
  });

  it.effect("cleans up when setup fails", () => {
    const fixture = operations([true]);
    const failure = new BootstrapExternalFailure({
      operation: "open-browser",
      message: "browser unavailable",
    });
    fixture.value.openBrowser = () => Effect.fail(failure);
    return bootstrapServer({ origin: "https://skit.example" }).pipe(
      Effect.provide(Layer.merge(fixture.layer, skitLayer)),
      Effect.flip,
      Effect.map((actual) => {
        assert.strictEqual(actual, failure);
        assert.isTrue(fixture.observed.secretRemoved);
      }),
    );
  });

  it.effect("rejects an invalid status response without retrying", () => {
    const invalid = new BootstrapStatusInvalid({ message: "Invalid response" });
    const fixture = operations([invalid, false]);
    return bootstrapServer({ origin: "https://skit.example" }).pipe(
      Effect.provide(Layer.merge(fixture.layer, skitLayer)),
      Effect.flip,
      Effect.map((failure) => {
        assert.strictEqual(failure, invalid);
        assert.strictEqual(fixture.observed.statusChecks, 1);
        assert.isUndefined(fixture.observed.openedUrl);
        assert.isTrue(fixture.observed.secretRemoved);
      }),
    );
  });

  it.effect("stops after five failed status attempts and preserves the last failure", () =>
    Effect.gen(function* () {
      const failures = Array.from({ length: 5 }, (_, i) => statusFailure(`failure ${i}`));
      const fixture = operations([...failures, false]);
      const fiber = yield* bootstrapServer({
        origin: "https://skit.example",
        pollIntervalMs: 1_000,
      }).pipe(Effect.provide(Layer.merge(fixture.layer, skitLayer)), Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(4_000);
      assert.strictEqual(yield* Fiber.join(fiber), failures[4]);
      assert.strictEqual(fixture.observed.statusChecks, 5);
      assert.isTrue(fixture.observed.secretRemoved);
    }),
  );

  for (const phase of ["status", "browser", "poll-delay"] as const) {
    it.effect(`enforces the setup deadline during ${phase} and finishes cleanup afterwards`, () =>
      Effect.gen(function* () {
        const fixture = operations([true, true, false]);
        const cleanupStarted = yield* Deferred.make<void>();
        const finishCleanup = yield* Deferred.make<void>();
        let interrupted = false;
        const stalled = Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        );
        if (phase === "status") fixture.value.bootstrapNeeded = () => stalled;
        if (phase === "browser") fixture.value.openBrowser = () => stalled;
        fixture.value.removeSecret = () =>
          Deferred.succeed(cleanupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishCleanup)),
          );
        const fiber = yield* bootstrapServer({
          origin: "https://skit.example",
          timeoutMs: 100,
          pollIntervalMs: 1_000,
        }).pipe(
          Effect.provide(Layer.merge(fixture.layer, skitLayer)),
          Effect.flip,
          Effect.forkChild,
        );
        yield* TestClock.adjust(100);
        yield* Deferred.await(cleanupStarted);
        // Cleanup has its own budget and must not be cut off by the setup deadline.
        yield* TestClock.adjust(500);
        yield* Deferred.succeed(finishCleanup, undefined);
        assert.instanceOf(yield* Fiber.join(fiber), BootstrapTimedOut);
        if (phase !== "poll-delay") assert.isTrue(interrupted);
        if (phase === "poll-delay") assert.strictEqual(fixture.observed.statusChecks, 2);
      }),
    );
  }

  it.effect("cleans up an unsuccessful secret installation without starting setup", () => {
    const fixture = operations([]);
    const failure = new BootstrapExternalFailure({
      operation: "install-secret",
      message: "Wrangler lost its connection after writing the secret",
    });
    fixture.value.installSecret = () => Effect.fail(failure);
    return bootstrapServer({ origin: "https://skit.example" }).pipe(
      Effect.provide(Layer.merge(fixture.layer, skitLayer)),
      Effect.flip,
      Effect.map((actual) => {
        assert.strictEqual(actual, failure);
        assert.strictEqual(fixture.observed.statusChecks, 0);
        assert.isTrue(fixture.observed.secretRemoved);
      }),
    );
  });

  for (const operation of ["install-secret", "remove-secret"] as const) {
    it.effect(`bounds a stalled ${operation} and interrupts the operation`, () =>
      Effect.gen(function* () {
        const fixture = operations([false]);
        let interrupted = false;
        const stalled = () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          );
        if (operation === "install-secret") fixture.value.installSecret = stalled;
        else fixture.value.removeSecret = stalled;
        const fiber = yield* bootstrapServer({ origin: "https://skit.example" }).pipe(
          Effect.provide(Layer.merge(fixture.layer, skitLayer)),
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
          assert.strictEqual(fixture.observed.statusChecks, 0);
          assert.isTrue(fixture.observed.secretRemoved);
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
      const fixture = operations([]);
      const original = new BootstrapExternalFailure({
        operation: "install-secret",
        message: "Not logged in",
      });
      const cleanup = new BootstrapExternalFailure({
        operation: "remove-secret",
        message: "Not logged in",
      });
      fixture.value.installSecret = () => Effect.fail(original);
      fixture.value.removeSecret = () => Effect.fail(cleanup);
      return bootstrapServer({ origin: "https://skit.example" }).pipe(
        Effect.provide(Layer.merge(fixture.layer, skitLayer)),
        Effect.flip,
        Effect.map((failure) => {
          assert.instanceOf(failure, BootstrapCleanupFailed);
          assert.strictEqual(failure.original, original);
          assert.strictEqual(failure.cleanup, cleanup);
          assert.match(failure.message, /^Bootstrap secret installation failed: Not logged in/);
          assert.match(failure.message, /If the secret was installed/);
          assert.match(failure.remediation, /^Check that Wrangler is installed and signed in/);
          assert.strictEqual(fixture.observed.statusChecks, 0);
        }),
      );
    },
  );

  it.effect("holds external cancellation during installation until its own timer expires", () =>
    Effect.gen(function* () {
      const fixture = operations([]);
      const installing = yield* Deferred.make<void>();
      let interrupted = false;
      fixture.value.installSecret = () =>
        Deferred.succeed(installing, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        );
      const fiber = yield* bootstrapServer({ origin: "https://skit.example" }).pipe(
        Effect.provide(Layer.merge(fixture.layer, skitLayer)),
        Effect.forkChild,
      );
      yield* Deferred.await(installing);
      const cancellation = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* TestClock.adjust("59 seconds");
      assert.isFalse(interrupted);
      assert.isUndefined(fiber.pollUnsafe());
      assert.isFalse(fixture.observed.secretRemoved);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(cancellation);
      assert.isTrue(interrupted);
      assert.isTrue(fixture.observed.secretRemoved);
    }),
  );

  it.effect("bounds secret cleanup even when the workflow has already been cancelled", () =>
    Effect.gen(function* () {
      const fixture = operations([]);
      const polling = yield* Deferred.make<void>();
      const removing = yield* Deferred.make<void>();
      let cleanupInterrupted = false;
      fixture.value.bootstrapNeeded = () =>
        Deferred.succeed(polling, undefined).pipe(Effect.andThen(Effect.never));
      fixture.value.removeSecret = () =>
        Deferred.succeed(removing, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              cleanupInterrupted = true;
            }),
          ),
        );
      const fiber = yield* bootstrapServer({ origin: "https://skit.example" }).pipe(
        Effect.provide(Layer.merge(fixture.layer, skitLayer)),
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
    const fixture = operations([true]);
    const original = new BootstrapExternalFailure({
      operation: "open-browser",
      message: "browser unavailable",
    });
    const cleanup = new BootstrapExternalFailure({
      operation: "remove-secret",
      message: "Cloudflare unavailable",
    });
    fixture.value.openBrowser = () => Effect.fail(original);
    fixture.value.removeSecret = () => Effect.fail(cleanup);
    return bootstrapServer({ origin: "https://skit.example" }).pipe(
      Effect.provide(Layer.merge(fixture.layer, skitLayer)),
      Effect.flip,
      Effect.map((failure) => {
        assert.instanceOf(failure, BootstrapCleanupFailed);
        assert.strictEqual(failure.original, original);
        assert.match(failure.message, /wrangler secret delete SKIT_BOOTSTRAP_SECRET/);
      }),
    );
  });

  it.effect("removes the secret when the workflow is interrupted", () => {
    const fixture = operations([]);
    return Effect.gen(function* () {
      const polling = yield* Deferred.make<void>();
      let checks = 0;
      fixture.value.bootstrapNeeded = () =>
        ++checks === 1
          ? Effect.succeed(true)
          : Deferred.succeed(polling, undefined).pipe(Effect.andThen(Effect.never));
      const fiber = yield* bootstrapServer({
        origin: "https://skit.example",
        pollIntervalMs: 0,
      }).pipe(Effect.provide(Layer.merge(fixture.layer, skitLayer)), Effect.forkChild);
      yield* Deferred.await(polling);
      yield* Fiber.interrupt(fiber);
      assert.isTrue(fixture.observed.secretRemoved);
    });
  });

  it.effect("decodes the top-level JSONC origin and rejects environments", () =>
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
        assert.strictEqual(yield* originFromWranglerConfig(config), "https://right.example");
        yield* fs.writeFileString(
          config,
          `{ "vars": { "PUBLIC_APP_ORIGIN": "https://right.example" }, "env": { "production": {} } }`,
        );
        const failure = yield* Effect.flip(originFromWranglerConfig(config));
        assert.instanceOf(failure, BootstrapConfigInvalid);
        assert.match(failure.message, /explicit --url/);
      }),
    ).pipe(Effect.provide(skitLayer)),
  );
});
