// The remote source download must own its response body.
//
// Before this, the body read carried no signal, a rejected status and an oversize response
// returned without cancelling, the byte limit was checked only after the whole response was
// buffered, and every rejection became a SourcePolicyViolation -- including a defect in our own
// code. These drive an injected Fetch and inspect the stream afterwards.

import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { resolveSkitSourceEffect } from "../src/acquisition/sources.js";
import { skitLayer } from "../src/platform/layer.js";

const URL_ARCHIVE = "https://registry.example/source.zip";
const URL_SKILL = "https://registry.example/skills/review/SKILL.md";

/** A body whose cancellation and lock state the test can inspect after the fact. */
function observableBody(chunks: readonly Uint8Array[], options: { stall?: boolean } = {}) {
  const state = { cancelled: false, pulls: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls += 1;
        const chunk = chunks[state.pulls - 1];
        if (chunk) return void controller.enqueue(chunk);
        // A stalled body never closes, so an interrupt has something live to cancel.
        if (!options.stall) controller.close();
        return new Promise<void>(() => {});
      },
      cancel() {
        state.cancelled = true;
      },
    },
    // No prefetch: `pull` then means a reader demanded a chunk, not that the stream filled
    // its own queue. Without this, the default high-water mark reads one chunk on its own and
    // "was the body consumed?" cannot be answered.
    { highWaterMark: 0 },
  );
  return { stream, state };
}

const clientFromResponse = (response: () => Response): HttpClient.HttpClient =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response())));

const resolve = (url: string, client: HttpClient.HttpClient) =>
  Effect.scoped(resolveSkitSourceEffect(url)).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provide(skitLayer),
  );

const failureTag = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "Success";
  const [first] = exit.cause.reasons;
  if (Cause.isDieReason(first)) return `Die(${(first.defect as Error)?.constructor?.name})`;
  return Cause.isFailReason(first) ? String((first.error as { _tag?: string })._tag) : "Interrupt";
};

const sourcePolicyReasonTag = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const [first] = exit.cause.reasons;
  if (!Cause.isFailReason(first)) return undefined;
  const failure = first.error as { _tag?: string; reason?: { _tag?: string } };
  return failure._tag === "SourcePolicyViolation" ? failure.reason?._tag : undefined;
};

describe("the source download body", () => {
  // Real time: the fetch and the stalled read only progress on the live clock.
  it.live("is cancelled when the operation is interrupted mid-body", () =>
    Effect.gen(function* () {
      const body = observableBody([new Uint8Array(8)], { stall: true });
      const client = clientFromResponse(
        () => new Response(body.stream, { headers: { "content-type": "application/zip" } }),
      );

      const fiber = yield* Effect.forkChild(resolve(URL_ARCHIVE, client));
      // Wait until the body is actually being read, so headers have already arrived.
      yield* Effect.sleep(50);
      yield* Fiber.interrupt(fiber);

      assert.isTrue(body.state.cancelled, "the body must be cancelled, not left streaming");
    }),
  );

  it.effect("rejects the status before reading the body", () =>
    Effect.gen(function* () {
      const body = observableBody([new Uint8Array(8)], { stall: true });
      const client = clientFromResponse(() => new Response(body.stream, { status: 404 }));

      const exit = yield* Effect.exit(resolve(URL_ARCHIVE, client));
      assert.strictEqual(failureTag(exit), "SourceNotFound");
      assert.strictEqual(body.state.pulls, 0, "a rejected response body must not be consumed");
    }),
  );

  it.effect("stops reading an archive that outgrows the limit despite its Content-Length", () =>
    Effect.gen(function* () {
      // The header understates the body by three orders of magnitude.
      const chunk = new Uint8Array(8 * 1024 * 1024);
      const body = observableBody(Array.from({ length: 40 }, () => chunk));
      const client = clientFromResponse(
        () =>
          new Response(body.stream, {
            headers: { "content-type": "application/zip", "content-length": "128" },
          }),
      );

      const exit = yield* Effect.exit(resolve(URL_ARCHIVE, client));
      assert.strictEqual(failureTag(exit), "SourcePolicyViolation");
      assert.strictEqual(sourcePolicyReasonTag(exit), "LimitExceeded");
      // 256 MiB is 32 chunks; stopping there proves the cap is enforced during the read.
      assert.isBelow(body.state.pulls, 40, "the read must stop at the limit, not at the end");
    }),
  );

  it.effect("stops reading a direct Skill that outgrows its smaller limit", () =>
    Effect.gen(function* () {
      const chunk = new Uint8Array(512 * 1024);
      const body = observableBody(Array.from({ length: 10 }, () => chunk));
      const client = clientFromResponse(
        () =>
          new Response(body.stream, {
            headers: { "content-type": "text/plain" },
          }),
      );

      const exit = yield* Effect.exit(resolve(URL_SKILL, client));
      assert.strictEqual(failureTag(exit), "SourcePolicyViolation");
      assert.strictEqual(sourcePolicyReasonTag(exit), "LimitExceeded");
      assert.isBelow(body.state.pulls, 10, "2 MiB is four chunks, not ten");
    }),
  );

  it.effect("lets a defect in our own code stay a defect", () =>
    Effect.gen(function* () {
      const client = HttpClient.make(() =>
        Effect.die(new ReferenceError("undefinedHelper is not defined")),
      );

      const exit = yield* Effect.exit(resolve(URL_ARCHIVE, client));
      assert.strictEqual(failureTag(exit), "Die(ReferenceError)");
    }),
  );

  it.effect("still reports an ordinary transport failure as a source failure", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new TypeError("failed") }),
          }),
        ),
      );

      const exit = yield* Effect.exit(resolve(URL_ARCHIVE, client));
      assert.strictEqual(failureTag(exit), "SourcePolicyViolation");
      assert.strictEqual(sourcePolicyReasonTag(exit), "Transport");
    }),
  );
});
