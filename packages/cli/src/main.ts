import { passiveCheckEnabled } from "./releases.js";
import { noticeRelease } from "./platform/releases.js";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import { FetchHttpClient } from "effect/http";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Fiber, Runtime } from "effect";
import { commandActor } from "./commands/actor.js";
import { skitCommand } from "./commands/tree.js";
import { jsonRequested } from "./commands/parameters.js";
import { runCommandTree } from "./commands/runtime.js";
import { Renderer } from "./terminal/renderer.js";
import { consoleRendererLayer } from "./terminal/console-renderer.js";

import { cliBuild } from "./commands/build-info.js";

const argv = process.argv.slice(2);
const json = jsonRequested(argv);
const command = runCommandTree(skitCommand, argv, cliBuild.version);
const passive = passiveCheckEnabled(cliBuild, {
  tty: process.stderr.isTTY === true,
  json,
  ci: Boolean(process.env.CI),
  disabled: Boolean(process.env.SKIT_NO_UPDATE_CHECK),
  argv,
});
const program = (
  passive
    ? Effect.scoped(
        Effect.gen(function* () {
          const refresh = yield* noticeRelease(cliBuild).pipe(Effect.forkScoped);
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
      ).pipe(Effect.provide(FetchHttpClient.layer))
    : command
).pipe(
  Effect.annotateLogs({ "skit.library.workflow": commandActor(skitCommand, argv) }),
  Effect.provide(skitConfigurationLayer()),
  Effect.provide(consoleRendererLayer(json)),
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program, {
  disableErrorReporting: true,
  teardown: (exit, onExit) =>
    Runtime.defaultTeardown(exit, (code) => onExit(Number(process.exitCode ?? 0) || code)),
});
