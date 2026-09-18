import { Deferred, Effect, Fiber, Result } from "effect";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { expect } from "vitest";
import {
  authorListCommand,
  listAuthorSkitsEffect,
  AuthorListHttpError,
  AuthorListIdentityError,
} from "../src/workflows/author/list.js";
import { SkitContractError } from "@smolai/skit-core";

import { renderCommandFailures } from "../src/application.js";
import type { ResolvedAuth } from "../src/registry/auth.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { registryApiFailureMessage } from "../src/registry/api-client.js";
import { CredentialsUnusable, RegistryOriginInvalid } from "../src/registry/failures.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { fetchTestClientLayer } from "./helpers/http-test-client.js";

const listWithFetch = (input: { origin?: string; token?: string }, fetcher: typeof fetch) =>
  listAuthorSkitsEffect(input).pipe(
    Effect.provide(registryHttpLayer(fetchTestClientLayer(fetcher))),
  );

const input = { origin: "https://registry.test", token: "test-token" };
const item = {
  skit_id: "tim/tools",
  visibility: "private",
  draft_revision_id: "draft_123",
  most_recent_release_version: null,
};
const page = (cursor: string | null = null, skits = [item]) =>
  Response.json({ skits, next_cursor: cursor });

const classifiedFailures = Effect.fn("AuthorListTest.classifiedFailures")(function* (
  authState: Result.Result<ResolvedAuth, CredentialsUnusable | RegistryOriginInvalid>,
  response: Response,
) {
  const interaction = yield* makeScriptedInteraction([]);
  yield* renderCommandFailures(authorListCommand({ authState })).pipe(
    Effect.provide(interaction.layer),
    Effect.provide(registryHttpLayer(fetchTestClientLayer(async () => response))),
    Effect.provide(NodeServices.layer),
  );
  return yield* interaction.failures;
});

const authState = (auth: Pick<ResolvedAuth, "origin" | "token">) =>
  Result.succeed({ ...auth, source: "environment" } as const);

it.effect.each([
  {
    label: "unusable auth state",
    authState: Result.fail(new CredentialsUnusable({ path: "/auth.json", reason: "invalid" })),
    response: page(),
    code: "CONFLICT",
    exitCode: 12,
  },
  {
    label: "invalid ambient origin",
    authState: Result.fail(new RegistryOriginInvalid({ origin: "bad-url" })),
    response: page(),
    code: "OPERATION_FAILED",
    exitCode: 1,
  },
  {
    label: "missing token",
    authState: authState({ origin: input.origin }),
    response: page(),
    code: "INVALID_ARGUMENT",
    exitCode: 64,
  },
  {
    label: "defensive invalid resolved origin",
    authState: authState({ origin: "bad-url", token: input.token }),
    response: page(),
    code: "OPERATION_FAILED",
    exitCode: 1,
  },
  {
    label: "unauthorized",
    authState: authState(input),
    response: new Response("null", { status: 401 }),
    code: "INVALID_ARGUMENT",
    exitCode: 64,
  },
  {
    label: "insufficient scope",
    authState: authState(input),
    response: Response.json({ error: "insufficient_scope" }, { status: 403 }),
    code: "INVALID_ARGUMENT",
    exitCode: 64,
  },
  {
    label: "unclassified forbidden",
    authState: authState(input),
    response: new Response("null", { status: 403 }),
    code: "OPERATION_FAILED",
    exitCode: 1,
  },
  {
    label: "malformed forbidden",
    authState: authState(input),
    response: new Response("broken", { status: 403 }),
    code: "OPERATION_FAILED",
    exitCode: 1,
  },
  {
    label: "server failure",
    authState: authState(input),
    response: Response.json({}, { status: 500 }),
    code: "OPERATION_FAILED",
    exitCode: 1,
  },
  {
    label: "malformed success",
    authState: authState(input),
    response: new Response("broken"),
    code: "OPERATION_FAILED",
    exitCode: 1,
  },
  {
    label: "null success",
    authState: authState(input),
    response: Response.json(null),
    code: "OPERATION_FAILED",
    exitCode: 1,
  },
  {
    label: "incomplete success",
    authState: authState(input),
    response: Response.json({}),
    code: "OPERATION_FAILED",
    exitCode: 1,
  },
])("classifies $label at the command boundary", ({ authState, response, code, exitCode }) =>
  Effect.gen(function* () {
    expect(yield* classifiedFailures(authState, response)).toEqual([
      expect.objectContaining({ code, exitCode }),
    ]);
  }),
);

it.effect.each(["first", "later", "body"] as const)(
  "interrupting %s aborts before another page",
  (stage) =>
    Effect.gen(function* () {
      // The fetcher is a plain callback, so it signals readiness through an unsafe completion
      // rather than a raw Promise the test would then have to await outside the runtime.
      const ready = Deferred.makeUnsafe<void>();
      const reached = () => Deferred.doneUnsafe(ready, Effect.void);
      let requests = 0;
      let finalized = false;
      const fetcher: typeof fetch = async (_url, init) => {
        requests++;
        if (stage === "later" && requests === 1) return page("next");
        const signal = init!.signal!;
        if (stage === "body") {
          return new Response(
            new ReadableStream(
              {
                pull(controller) {
                  signal.addEventListener(
                    "abort",
                    () => {
                      finalized = true;
                      controller.error(signal.reason);
                    },
                    { once: true },
                  );
                  reached();
                },
              },
              { highWaterMark: 0 },
            ),
          );
        }
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              finalized = true;
              reject(signal.reason);
            },
            { once: true },
          );
          reached();
        });
      };
      const fiber = yield* Effect.forkChild(listWithFetch(input, fetcher));
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      expect(finalized).toBe(true);
      expect(requests).toBe(stage === "later" ? 2 : 1);
    }),
);

it.effect("request and body rejections use Effect HTTP's typed failure channel", () =>
  Effect.forEach(["request", "body"] as const, (stage) => {
    let requests = 0;
    const rejection = new ReferenceError("request rejected");
    return listWithFetch(input, async () => {
      requests++;
      if (stage === "request") throw rejection;
      const response = page("next");
      response.arrayBuffer = async () => {
        throw rejection;
      };
      return response;
    }).pipe(
      Effect.flip,
      Effect.map((failure) => {
        assert.match(
          failure.message,
          stage === "request" ? /Unable to reach Registry/ : /author SKIT list response/,
        );
        assert.strictEqual(requests, 1);
      }),
    );
  }),
);

it.effect("expected transport, contract and identity failures use declared channels", () =>
  Effect.gen(function* () {
    for (const [fetcher, kind] of [
      [
        async () => {
          throw new TypeError("offline");
        },
        AuthorListHttpError,
      ],
      [async () => new Response("broken"), SkitContractError],
      [async () => Response.json(null), SkitContractError],
      [async () => page(null, [{ ...item, skit_id: "invalid" }]), AuthorListIdentityError],
    ] as const) {
      const failure = yield* listWithFetch(input, fetcher).pipe(
        Effect.match({ onFailure: (error) => error, onSuccess: () => null }),
      );
      expect(failure).toBeInstanceOf(kind);
    }
  }),
);

it.effect.each([false, true])("page 1000 terminal=%s retains guard position", (terminal) =>
  Effect.gen(function* () {
    let requests = 0;
    const exit = yield* Effect.exit(
      listWithFetch(input, async () => {
        requests++;
        return page(terminal && requests === 1000 ? null : String(requests), []);
      }),
    );
    expect(requests).toBe(1000);
    expect(exit._tag).toBe(terminal ? "Success" : "Failure");
  }),
);

it.effect.each([false, true])("item limit terminal=%s retains terminal acceptance", (terminal) =>
  Effect.gen(function* () {
    let requests = 0;
    const exit = yield* Effect.exit(
      listWithFetch(input, async () => {
        requests++;
        return page(
          requests === 1 ? "next" : terminal ? null : "again",
          Array.from({ length: requests === 1 ? 100000 : 1 }, () => item),
        );
      }),
    );
    expect(requests).toBe(2);
    expect(exit._tag).toBe(terminal ? "Success" : "Failure");
  }),
);

it.effect("later failure discards accumulated inventory", () =>
  Effect.gen(function* () {
    let requests = 0;
    const value = yield* listWithFetch(input, async () => {
      requests++;
      return requests === 1 ? page("next") : new Response("broken");
    }).pipe(Effect.match({ onFailure: (error) => error, onSuccess: (value) => value }));
    expect(value).toBeInstanceOf(SkitContractError);
    expect(requests).toBe(2);
  }),
);

it.effect.each([null, [], 3, { error: null }, { error: {} }])(
  "invalid rejection body %j has a deliberate diagnostic",
  (body) =>
    Effect.sync(() => {
      expect(registryApiFailureMessage("Author SKIT list", body, { defaultStatus: 403 })).toBe(
        "Author SKIT list failed (403): Registry returned an invalid error response",
      );
    }),
);

it.effect("identity validation is selectively recoverable", () =>
  Effect.gen(function* () {
    const value = yield* listWithFetch(input, async () =>
      page(null, [{ ...item, skit_id: "invalid" }]),
    ).pipe(Effect.catchTag("AuthorListIdentityError", (error) => Effect.succeed(error.identity)));
    expect(value).toBe("invalid");
  }),
);
