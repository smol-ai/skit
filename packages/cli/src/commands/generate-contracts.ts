// A process entrypoint: one program, run once, on the Node platform.
import { Effect, FileSystem } from "effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { join, resolve } from "node:path";
import { commandContractArtifacts } from "./artifacts.js";
import { commandApplicationLayer } from "../application.js";

const target = resolve(import.meta.dirname, "../../../contracts");

// These generated files are committed so versioned contract changes are visible during review.
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(target, { recursive: true });
  const artifacts = yield* commandContractArtifacts();
  for (const [name, contents] of Object.entries(artifacts))
    yield* fs.writeFileString(join(target, name), contents);
});

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(commandApplicationLayer(false, join(target, ".generation-home"))),
    Effect.provide(NodeServices.layer),
  ),
);
