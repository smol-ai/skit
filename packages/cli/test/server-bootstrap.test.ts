import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer } from "effect";
import { skitLayer } from "@smolai/skit-core";
import { renderContract } from "../src/presentation/contract-presenters.js";
import {
  BootstrapCleanupFailed,
  BootstrapConfigInvalid,
  BootstrapExternalFailure,
  BootstrapOperations,
  bootstrapServerEffect,
  originFromWranglerConfigEffect,
  removeBootstrapSecretInvocation,
  type BootstrapOperationsShape,
} from "../src/bootstrap/server-bootstrap.js";

function operations(statuses: Array<boolean | BootstrapExternalFailure>) {
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
        "skit.server.bootstrap.v1",
        { origin: "https://skit.example", status: "complete" },
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
      const result = yield* bootstrapServerEffect({
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
      const result = yield* bootstrapServerEffect({
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
      const result = yield* bootstrapServerEffect({
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
    return bootstrapServerEffect({ origin: "https://skit.example" }).pipe(
      Effect.provide(Layer.merge(fixture.layer, skitLayer)),
      Effect.flip,
      Effect.map((actual) => {
        assert.strictEqual(actual, failure);
        assert.isTrue(fixture.observed.secretRemoved);
      }),
    );
  });

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
    return bootstrapServerEffect({ origin: "https://skit.example" }).pipe(
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
      const fiber = yield* bootstrapServerEffect({
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
        assert.strictEqual(yield* originFromWranglerConfigEffect(config), "https://right.example");
        yield* fs.writeFileString(
          config,
          `{ "vars": { "PUBLIC_APP_ORIGIN": "https://right.example" }, "env": { "production": {} } }`,
        );
        const failure = yield* Effect.flip(originFromWranglerConfigEffect(config));
        assert.instanceOf(failure, BootstrapConfigInvalid);
        assert.match(failure.message, /explicit --url/);
      }),
    ).pipe(Effect.provide(skitLayer)),
  );
});
