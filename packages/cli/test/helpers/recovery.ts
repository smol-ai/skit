import * as Library from "@smolai/skit-core/library";
import { Effect } from "effect";
import { testRoots } from "./roots.js";

/** Exercise the same public recovery facts used by the command. */
export const recoveryList = (home: string) =>
  Effect.flatMap(Library.Service, (owner) => owner.recovery.list).pipe(
    Effect.provide(Library.layer({ home, roots: testRoots(home) })),
  );
export const recoveryInspection = (home: string, operationId: string) =>
  Effect.flatMap(Library.Service, (owner) => owner.recovery.inspect(operationId)).pipe(
    Effect.provide(Library.layer({ home, roots: testRoots(home) })),
  );
