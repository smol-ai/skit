import { fileURLToPath } from "node:url";
import { Effect, FileSystem } from "effect";

export const copySkitFixtureEffect = Effect.fn("Test.copySkitFixture")(function* (
  name: "authored" | "sentinel-id",
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const fixture = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  yield* fs.copy(fixture, root);
});
