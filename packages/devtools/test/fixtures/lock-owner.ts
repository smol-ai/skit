import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Configuration } from "../../src/configuration.ts";
import { withLock } from "../../src/state.ts";
const root = process.argv[2];
if (!root) throw new Error("Missing lock fixture directory.");
NodeRuntime.runMain(
  withLock("skit-crash", Console.log("LOCKED").pipe(Effect.andThen(Effect.never))).pipe(
    Effect.provideService(Configuration, {
      root,
      repo: root,
      tart: "unused",
      authPath: "unused",
      requestedCodex: "latest",
      guestScript: new Uint8Array(),
      fingerprint: "fixture",
    }),
    Effect.provide(NodeServices.layer),
  ),
);
