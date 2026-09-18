import { Effect, Predicate } from "effect";
import { assert, it } from "@effect/vitest";
import { SourceProcess, skitLayer } from "../src/index.js";
import { execPath } from "node:process";

it.effect("captures stdout and stderr while retaining the exit status", () =>
  Effect.gen(function* () {
    const runner = yield* SourceProcess;
    const result = yield* runner.output(execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7",
    ]);
    assert.strictEqual(new TextDecoder().decode(result.stdout), "out");
    assert.strictEqual(result.stderr, "err");
    assert.strictEqual(result.exitCode, 7);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("interrupts a subprocess as soon as its output exceeds the byte budget", () =>
  Effect.gen(function* () {
    const runner = yield* SourceProcess;
    const failure = yield* runner
      .output(execPath, ["-e", "process.stdout.write('12345')"], { maxOutputBytes: 4 })
      .pipe(Effect.flip);
    assert.isTrue(Predicate.isTagged(failure, "SourceProcess.OutputTooLarge"));
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "disables interactive Git credential prompts without discarding the inherited environment",
  () =>
    Effect.gen(function* () {
      const runner = yield* SourceProcess;
      const result = yield* runner.output("git", [
        "-c",
        'alias.skit-env=!f() { printf "%s:%s" "$GIT_TERMINAL_PROMPT" "${PATH:+inherited}"; }; f',
        "skit-env",
      ]);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(new TextDecoder().decode(result.stdout), "0:inherited");
    }).pipe(Effect.provide(skitLayer)),
);

it.live("interrupts a subprocess at the configured timeout", () =>
  Effect.gen(function* () {
    const runner = yield* SourceProcess;
    const failure = yield* runner
      .run(execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 25 })
      .pipe(Effect.flip);
    assert.isTrue(Predicate.isTagged(failure, "SourceProcess.TimedOut"));
  }).pipe(Effect.provide(skitLayer)),
);
