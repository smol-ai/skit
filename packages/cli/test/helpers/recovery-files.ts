import { Effect, Option } from "effect";
import { join } from "node:path";
import { Library } from "@smolai/skit-core/library";
import { observePathEvidence } from "@smolai/skit-core";
/** Create recovery fixtures through the same recorded owner used by setup. */
export const saveRecoveryFiles = (home: string, paths: readonly string[]) =>
  Effect.gen(function* () {
    const owner = yield* Library.Service;
    const folders = yield* Effect.forEach(paths, (path) =>
      Effect.gen(function* () {
        const evidence = yield* observePathEvidence(path);
        if (Option.isNone(evidence)) return yield* Effect.die(`Missing fixture path ${path}`);
        return evidence.value;
      }),
    );
    const result = yield* owner.setup([{ _tag: "Remove", folders }], { base: yield* owner.read });
    return { result, operationDirectory: join(home, "removed", result.operationId) };
  }).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));
