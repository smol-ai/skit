import { Effect, FileSystem } from "effect";
import { makeMachineId } from "../../src/library/entity-ids.js";
import { join } from "node:path";
export const nativeLibraryFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-listing-" });
  const home = join(root, "home");
  yield* fs.makeDirectory(home, { recursive: true });
  yield* fs.writeFileString(
    join(home, "machine.json"),
    JSON.stringify({
      schemaVersion: 3,
      machineId: makeMachineId(),
      displayName: "Test machine",
      repositoryRoots: [],
    }),
  );
  return { root, home };
});
