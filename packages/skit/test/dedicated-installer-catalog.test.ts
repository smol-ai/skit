import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { skitLayer } from "../src/platform/layer.js";
import { parseSkitSource } from "../src/sources/resolve.js";
import {
  DedicatedInstallerRequired,
  dedicatedInstallerForSource,
  checkSourceInstaller,
} from "../src/sources/installer-guidance.js";

it.effect("rejects known GitHub Sources with their dedicated installer guidance", () =>
  Effect.gen(function* () {
    for (const input of [
      "pbakaus/impeccable",
      "gh:pbakaus/impeccable",
      "github:pbakaus/impeccable",
      "https://github.com/pbakaus/impeccable",
      "https://github.com/PBAKAUS/IMPECCABLE.git",
      "https://github.com/PBAKAUS/IMPECCABLE/tree/main",
    ]) {
      const failure = yield* checkSourceInstaller(yield* parseSkitSource(input)).pipe(Effect.flip);
      assert.instanceOf(failure, DedicatedInstallerRequired);
      assert.strictEqual(failure.sourceCoordinate, "github:pbakaus/impeccable");
      assert.strictEqual(failure.command, "npx impeccable install");
      assert.strictEqual(failure.code, "INVALID_ARGUMENT");
    }
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("does not classify unrelated or local Sources as dedicated-installer Sources", () =>
  Effect.sync(() => {
    assert.strictEqual(
      dedicatedInstallerForSource({ type: "github", owner: "acme", repository: "skills" }),
      undefined,
    );
    assert.strictEqual(
      dedicatedInstallerForSource({ type: "local", path: "/work/pbakaus/impeccable" }),
      undefined,
    );
  }),
);
