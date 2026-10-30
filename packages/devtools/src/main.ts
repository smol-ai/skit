import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { release } from "node:os";
import { Console, Effect, FileSystem, Layer, Option, Runtime } from "effect";
import { Argument, CliConfig, Command, Flag, GlobalFlag } from "effect/cli";
import { Configuration, configurationLayer, VmError } from "./configuration.ts";
import { processesLayer } from "./processes.ts";
import { tartLayer } from "./tart.ts";
import { makeVm } from "./vm.ts";

const program = Effect.gen(function* () {
  const vm = yield* makeVm;
  const config = yield* Configuration;
  const fs = yield* FileSystem.FileSystem;
  const hostReady = Effect.gen(function* () {
    if (
      process.platform !== "darwin" ||
      process.arch !== "arm64" ||
      Number(release().split(".")[0]) < 23 ||
      Number(process.versions.node.split(".")[0]) < 22
    )
      return yield* new VmError({
        message: "SKIT VM requires Node 22+ on an Apple Silicon Mac running macOS 14+.",
      });
    yield* fs.makeDirectory(config.root, { recursive: true, mode: 0o700 });
    yield* fs.chmod(config.root, 0o700);
  });
  const name = Argument.String("name");
  const command = Command.make("vm").pipe(
    Command.withDescription("Disposable Linux homes for SKIT and interactive Codex."),
    Command.withSubcommands([
      Command.make("install-tart", {}, () => hostReady.pipe(Effect.andThen(vm.install))),
      Command.make("baseline", {}, () =>
        hostReady.pipe(Effect.andThen(vm.ready), Effect.andThen(vm.baseline)),
      ),
      Command.make("reset", {}, () =>
        hostReady.pipe(Effect.andThen(vm.ready), Effect.andThen(vm.reset)),
      ),
      Command.make(
        "new",
        {
          name: name.pipe(Argument.optional),
          fixture: Flag.Literals("fixture", ["swyx"]).pipe(Flag.optional),
        },
        (input) =>
          hostReady.pipe(
            Effect.andThen(vm.ready),
            Effect.andThen(
              vm.newTrial(Option.getOrUndefined(input.name), Option.getOrUndefined(input.fixture)),
            ),
          ),
      ),
      Command.make("build", { name }, (input) =>
        hostReady.pipe(Effect.andThen(vm.ready), Effect.andThen(vm.build(input.name))),
      ),
      Command.make("auth-copy", { name }, (input) =>
        hostReady.pipe(Effect.andThen(vm.ready), Effect.andThen(vm.copyAuth(input.name))),
      ),
      ...(["shell", "login", "codex"] as const).map((kind) =>
        Command.make(kind, { name }, (input) =>
          hostReady.pipe(
            Effect.andThen(vm.ready),
            Effect.andThen(vm.attach(input.name, kind)),
            Effect.tap((code) =>
              Effect.sync(() => {
                process.exitCode = code;
              }),
            ),
          ),
        ),
      ),
      Command.make("stop", { name }, (input) =>
        hostReady.pipe(Effect.andThen(vm.ready), Effect.andThen(vm.stop(input.name))),
      ),
      Command.make(
        "rm",
        { name, baseline: Flag.Boolean("baseline").pipe(Flag.withDefault(false)) },
        (input) =>
          hostReady.pipe(
            Effect.andThen(vm.ready),
            Effect.andThen(vm.remove(input.name, input.baseline)),
          ),
      ),
      Command.make("list", {}, () =>
        hostReady.pipe(Effect.andThen(vm.ready), Effect.andThen(vm.list)),
      ),
    ]),
  );
  yield* Command.runWith(command, { version: "0.0.0" })(
    process.argv.slice(2).map((arg) => (arg === "help" ? "--help" : arg)),
  );
});
const configuration = configurationLayer;
const processes = processesLayer;
const tart = tartLayer.pipe(Layer.provide(configuration), Layer.provide(processes));
const services = Layer.mergeAll(configuration, processes, tart);
const terminalProgram = Effect.acquireUseRelease(
  Effect.sync(() => {
    const onHangup = () => process.kill(process.pid, "SIGTERM");
    process.on("SIGHUP", onHangup);
    return onHangup;
  }),
  () => program,
  (onHangup) =>
    Effect.sync(() => {
      process.removeListener("SIGHUP", onHangup);
    }),
);
NodeRuntime.runMain(
  terminalProgram.pipe(
    Effect.provide(services),
    Effect.provide(NodeServices.layer),
    Effect.provide(
      CliConfig.layer({
        builtIns: GlobalFlag.BuiltIns.filter((flag) => flag !== GlobalFlag.Wizard),
      }),
    ),
    Effect.catchTag("VmError", (error) =>
      Console.error(error.message).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
  ),
  {
    teardown: (exit, onExit) =>
      Runtime.defaultTeardown(exit, (code) => onExit(Number(process.exitCode ?? 0) || code)),
  },
);
