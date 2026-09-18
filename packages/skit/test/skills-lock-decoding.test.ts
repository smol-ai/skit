// The adjacent skills.sh lock is consumption state SKIT reads but never owns. A file containing
// `null` used to throw from inside the guard meant to check it, so these pin the whole shape
// matrix and the promise that initialization never rewrites the file.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, FileSystem } from "effect";
import { join } from "node:path";
import { initSkitEffect, skitLayer } from "../src/index.js";

const SKILL = "---\nname: probe\ndescription: A probe skill\n---\n\nBody.\n";

const initWith = Effect.fn("initWith")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-lock-" });
  yield* fs.writeFileString(join(root, "SKILL.md"), SKILL);
  yield* fs.writeFileString(join(root, "skills-lock.json"), lock);
  const exit = yield* Effect.exit(initSkitEffect(root));
  const after = yield* fs.readFileString(join(root, "skills-lock.json"));
  return { exit, after };
});

describe("the adjacent skills-lock file", () => {
  it.effect.each([
    { lock: "null", entries: 0, why: "a JSON null" },
    { lock: "42", entries: 0, why: "a scalar" },
    { lock: "[]", entries: 0, why: "an array" },
    { lock: '{"skills":null}', entries: 0, why: "a null skills member" },
    { lock: '{"skills":[1,2]}', entries: 0, why: "an array skills member" },
    { lock: "not json at all", entries: 0, why: "invalid JSON" },
    { lock: '{"skills":{}}', entries: 0, why: "no entries" },
    { lock: '{"skills":{"a":1,"b":2}}', entries: 2, why: "two entries" },
  ])("counts $why as $entries entries without failing", ({ lock, entries }) =>
    Effect.gen(function* () {
      const { exit, after } = yield* initWith(lock);
      // Not merely "did not fail": a defect would also be a non-Success exit, and a defect is
      // exactly what this file used to produce.
      assert.isTrue(Exit.isSuccess(exit), "initialization must not fail or die on any lock shape");
      if (!Exit.isSuccess(exit)) return;
      assert.deepStrictEqual(exit.value.discovered.skillsLock, { present: true, entries });
      assert.strictEqual(after, lock, "the lock is consumption state and must survive verbatim");
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("reports no lock when the file is absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-lock-" });
      yield* fs.writeFileString(join(root, "SKILL.md"), SKILL);
      const result = yield* initSkitEffect(root);
      assert.deepStrictEqual(result.discovered.skillsLock, { present: false, entries: 0 });
    }).pipe(Effect.provide(skitLayer)),
  );
});
