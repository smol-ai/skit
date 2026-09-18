import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { LibraryActor } from "@smolai/skit-core";
import { Effect, Runtime } from "effect";
import { commandActor } from "./commands/actor.js";
import { skitCommand } from "./commands/tree.js";
import { jsonRequested } from "./commands/parameters.js";
import { runCommandTree } from "./commands/runtime.js";
import { consoleRendererLayer } from "./presentation/renderer.js";

declare const __SKIT_VERSION__: string;

const argv = process.argv.slice(2);
const json = jsonRequested(argv);
const program = runCommandTree(skitCommand, argv, __SKIT_VERSION__).pipe(
  Effect.provideService(LibraryActor, commandActor(skitCommand, argv)),
  Effect.provide(consoleRendererLayer(json)),
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program, {
  disableErrorReporting: true,
  teardown: (exit, onExit) =>
    Runtime.defaultTeardown(exit, (code) => onExit(Number(process.exitCode ?? 0) || code)),
});
