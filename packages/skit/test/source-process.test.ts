import { Deferred, Effect, Fiber, Predicate, Stream } from "effect";
import { assert, it } from "@effect/vitest";
import { SourceProcess, skitLayer } from "../src/index.js";
import { execPath } from "node:process";

it.effect("pipes binary chunks and closes stdin while draining both output streams", () =>
  Effect.gen(function* () {
    const runner = yield* SourceProcess;
    const input = [Uint8Array.from([0, 128, 255]), Buffer.alloc(128_000, 17)];
    const result = yield* runner.output(
      execPath,
      [
        "-e",
        `
      process.stderr.write('ready:');
      process.stdin.on('data', (chunk) => process.stdout.write(chunk));
      process.stdin.on('end', () => { process.stderr.write('eof'); process.exitCode = 7; });
    `,
      ],
      { stdin: Stream.fromIterable(input) },
    );
    assert.deepStrictEqual(Buffer.from(result.stdout), Buffer.concat(input));
    assert.strictEqual(result.stderr, "ready:eof");
    assert.strictEqual(result.exitCode, 7);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("interrupting the child also closes its pending input stream", () =>
  Effect.gen(function* () {
    const runner = yield* SourceProcess;
    const started = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const input = Stream.fromEffect(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Stream.ensuring(Deferred.succeed(closed, undefined)));
    const pending = yield* runner
      .output(execPath, ["-e", "process.stdin.resume()"], { stdin: input })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(pending);
    assert.isTrue(yield* Deferred.isDone(closed));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

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

it.effect("explicit undefined removes an environment value instead of preserving its default", () =>
  Effect.gen(function* () {
    const runner = yield* SourceProcess;
    const result = yield* runner.output(
      "git",
      ["-c", 'alias.skit-unset=!printf "%s" "${GIT_TERMINAL_PROMPT-unset}"', "skit-unset"],
      {
        environment: { GIT_TERMINAL_PROMPT: undefined },
      },
    );
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(new TextDecoder().decode(result.stdout), "unset");
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
