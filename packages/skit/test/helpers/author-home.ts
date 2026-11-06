import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { makeMachineId } from "../../src/library/entity-ids.js";
import * as Library from "../../src/library/index.js";
export const libraryHome = Effect.fn("Test.authorHome")(function* ({ home }: { home: string }) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(home, { recursive: true });
  yield* fs.writeFileString(
    join(home, "machine.json"),
    JSON.stringify({
      schemaVersion: 3,
      machineId: makeMachineId(),
      displayName: "Test",
      repositoryRoots: [],
    }),
  );
  return {
    home,
    snapshot: Effect.flatMap(Library.Service, (owner) => owner.read).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
    ),
  };
});
