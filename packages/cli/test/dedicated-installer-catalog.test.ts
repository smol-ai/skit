import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { skitLayer } from "@smolai/skit-core";
import {
  DedicatedInstallerRequired,
  dedicatedInstallerForSource,
  rejectDedicatedInstallerSourceEffect,
} from "../src/workflows/library/dedicated-installer-catalog.js";

it.effect("rejects known GitHub Sources with their dedicated installer guidance", () =>
  Effect.gen(function* () {
    for (const input of [
      "pbakaus/impeccable",
      "gh:pbakaus/impeccable",
      "github:pbakaus/impeccable",
      "https://github.com/pbakaus/impeccable",
      "https://github.com/PBAKAUS/IMPECCABLE.git#ref=main",
    ]) {
      const failure = yield* rejectDedicatedInstallerSourceEffect(input).pipe(Effect.flip);
      assert.instanceOf(failure, DedicatedInstallerRequired);
      assert.strictEqual(failure.sourceCoordinate, "github:pbakaus/impeccable");
      assert.strictEqual(failure.command, "npx impeccable install");
      assert.strictEqual(failure.code, "INVALID_ARGUMENT");
      assert.strictEqual(failure.exitCode, 64);
    }
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("does not classify unrelated or local Sources as dedicated-installer Sources", () =>
  Effect.sync(() => {
    assert.strictEqual(
      dedicatedInstallerForSource({
        type: "git",
        locator: "https://github.com/acme/skills.git",
      }),
      undefined,
    );
    assert.strictEqual(
      dedicatedInstallerForSource({ type: "local", locator: "/work/pbakaus/impeccable" }),
      undefined,
    );
  }),
);
