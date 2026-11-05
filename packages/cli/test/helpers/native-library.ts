import { Effect, FileSystem } from "effect";
import { makeMachineId } from "@smolai/skit-core";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const nativeLibraryFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-native-library-" });
  const source = join(root, "source");
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
  yield* fs.copy(fileURLToPath(new URL("../fixtures/library", import.meta.url)), source);
  return {
    root,
    source,
    home,
  };
});
