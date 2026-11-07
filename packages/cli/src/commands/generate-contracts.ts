// A process entrypoint: one program, run once, on the Node platform.
import { Effect } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { join, resolve } from "node:path";
import { commandContractArtifacts } from "./artifacts.js";
import { writeCommandContractArtifacts } from "../platform/command-contracts.js";
import { cliLayer } from "../application.js";

const target = resolve(import.meta.dirname, "../../../contracts");

// These generated files are committed so versioned contract changes are visible during review.
const program = Effect.gen(function* () {
  const artifacts = yield* commandContractArtifacts();
  yield* writeCommandContractArtifacts(target, artifacts);
});

NodeRuntime.runMain(
  program.pipe(Effect.scoped, Effect.provide(cliLayer(false, join(target, ".generation-home")))),
);
