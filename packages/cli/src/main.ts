import { FetchHttpClient } from "effect/unstable/http";
import { Layer } from "effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { LibraryActor } from "@smolai/skit-core";
import { Effect, Fiber, Runtime } from "effect";
import { commandActor } from "./commands/actor.js";
import { skitCommand } from "./commands/tree.js";
import { jsonRequested } from "./commands/parameters.js";
import { runCommandTree } from "./commands/runtime.js";
import { consoleRendererLayer } from "./presentation/renderer.js";

import { cliBuild } from "./build-info.js";
import { ReleaseChecker, releaseCheckerLayer } from "./releases/checker.js";
import { Renderer } from "./presentation/renderer.js";

const argv = process.argv.slice(2);
const json = jsonRequested(argv);
const command = runCommandTree(skitCommand, argv, cliBuild.version);
const passive =
  cliBuild.kind === "release" &&
  process.stderr.isTTY &&
  !json &&
  !process.env.CI &&
  !process.env.SKIT_NO_UPDATE_CHECK &&
  !argv.some((arg) => ["version", "--version", "-v", "--help", "-h"].includes(arg));
const program = (
  passive
    ? Effect.scoped(
        Effect.gen(function* () {
          const checker = yield* ReleaseChecker;
          const refresh = yield* checker.notice(cliBuild).pipe(Effect.forkScoped);
          yield* command;
          const update = yield* Fiber.join(refresh);
          if (update) {
            const renderer = yield* Renderer;
            yield* renderer.note(
              `${cliBuild.version} → ${update.available}\n${update.upgrade}`,
              "Update available",
            );
          }
        }),
      ).pipe(Effect.provide(releaseCheckerLayer.pipe(Layer.provide(FetchHttpClient.layer))))
    : command
).pipe(
  Effect.provideService(LibraryActor, commandActor(skitCommand, argv)),
  Effect.provide(consoleRendererLayer(json)),
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program, {
  disableErrorReporting: true,
  teardown: (exit, onExit) =>
    Runtime.defaultTeardown(exit, (code) => onExit(Number(process.exitCode ?? 0) || code)),
});
