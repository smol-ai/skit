import { assert, it } from "@effect/vitest";
import { skitLayer } from "@smolai/skit-core";
import { Effect } from "effect";
import { probeRequestedHarnessesEffect } from "../src/harness/probe.js";

it.effect("probes every supported Harness when no subject is requested", () =>
  Effect.gen(function* () {
    const probes = yield* probeRequestedHarnessesEffect(undefined, { path: "" });
    assert.deepStrictEqual(
      probes.map((probe) => probe.harnessId),
      ["codex", "claude-code", "opencode", "devin"],
    );
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("probes only the Harness selected by a valid alias", () =>
  Effect.gen(function* () {
    const probes = yield* probeRequestedHarnessesEffect("claude", { path: "" });
    assert.deepStrictEqual(
      probes.map((probe) => probe.harnessId),
      ["claude-code"],
    );
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("rejects an unknown Harness without starting probes", () =>
  probeRequestedHarnessesEffect("mystery").pipe(
    Effect.provide(skitLayer),
    Effect.flip,
    Effect.map((failure) => {
      if (failure._tag !== "UnknownHarness") return assert.fail(failure._tag);
      assert.strictEqual(failure.value, "mystery");
    }),
  ),
);
