import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { versionCommand } from "../src/handlers/version.js";
import { cliBuild } from "../src/build-info.js";

it.effect("uses the same artifact identity as --version without filesystem access", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* versionCommand(), cliBuild.version);
    assert.strictEqual(cliBuild.kind, "dev");
  }),
);
