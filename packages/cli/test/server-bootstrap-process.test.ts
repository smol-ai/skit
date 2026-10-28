import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { NodeServices } from "@effect/platform-node";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { consoleRendererLayer } from "../src/presentation/renderer.js";
import {
  BootstrapExternalFailure,
  bootstrapServer,
  bootstrapOperationsLayer,
} from "../src/bootstrap/server-bootstrap.js";

it.effect("terminates a real Wrangler substitute that ignores SIGTERM", () =>
  Effect.gen(function* () {
    const native = yield* ChildProcessSpawner.ChildProcessSpawner;
    const ready = yield* Deferred.make<void>();
    let child: ChildProcessSpawner.ChildProcessHandle | undefined;
    const spawner = ChildProcessSpawner.ChildProcessSpawner.of({
      ...native,
      spawn: (command) => {
        if (command._tag !== "StandardCommand") return native.spawn(command);
        // Keep the production command's options, including its termination policy.
        const script = command.args.includes("put")
          ? 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);'
          : "process.exit(0);";
        return native
          .spawn(ChildProcess.make(process.execPath, ["-e", script], command.options))
          .pipe(
            Effect.map((handle) => {
              if (command.args.includes("put")) child = handle;
              return {
                ...handle,
                all: handle.all.pipe(Stream.tap(() => Deferred.succeed(ready, undefined))),
              };
            }),
          );
      },
    });
    const layer = bootstrapOperationsLayer("wrangler-substitute").pipe(
      Layer.provide(Layer.merge(registryHttpLayer(), consoleRendererLayer(true))),
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    );
    const fiber = yield* bootstrapServer({ origin: "https://skit.example" }).pipe(
      Effect.provide(layer),
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    yield* TestClock.adjust("1 minute");
    const failure = yield* Fiber.join(fiber);
    assert.instanceOf(failure, BootstrapExternalFailure);
    assert.strictEqual(failure.operation, "install-secret");
    assert.isDefined(child);
    if (child) assert.isFalse(yield* child.isRunning);
  }).pipe(Effect.provide(NodeServices.layer)),
);
