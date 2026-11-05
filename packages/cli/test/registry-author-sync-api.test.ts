import { expect } from "vitest";
import { assert, it } from "@effect/vitest";
import * as History from "@smolai/skit-core/history";
import { Effect } from "effect";
import { authorSyncApi } from "../src/registry/author-sync.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { testHttpClientLayer } from "./helpers/http-test-client.js";

const input = {
  remote: {
    schema: "skit.remote.v1" as const,
    origin: "https://registry.test",
    namespace: "tim",
    skit: "tools",
  },
  locator: "skit://registry.test/tim/tools",
  token: "test-token",
};

it.effect.each([
  { requestId: "", status: 201, contract: "skit create request", requests: 0 },
  { requestId: "saved-request", status: 201, contract: "skit create response", requests: 1 },
])(
  "distinguishes $contract at the actual encoding/decoding boundary",
  ({ requestId, status, contract, requests }) =>
    Effect.gen(function* () {
      let sent = 0;
      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          const api = yield* authorSyncApi(input);
          return yield* api.create("private", requestId);
        }),
      ).pipe(
        Effect.provide(
          registryHttpLayer(
            testHttpClientLayer(() => {
              sent++;
              return Effect.succeed(Response.json({}, { status }));
            }),
          ),
        ),
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "SkitContractError");
      if (failure._tag === "SkitContractError") assert.strictEqual(failure.contract, contract);
      assert.strictEqual(sent, requests);
    }),
);

it.effect.each([
  { status: 401, body: { error: "unauthorized" }, tag: "AuthenticationRequired" },
  { status: 403, body: { error: "insufficient_scope" }, tag: "CredentialLacksScope" },
  { status: 403, body: { error: "forbidden" }, tag: "SyncRejected" },
  { status: 404, body: { error: "skit_not_found" }, tag: "RemoteSkitUnavailable" },
  { status: 502, body: { error: "gateway" }, tag: "SyncRejected" },
  { status: 200, body: {}, tag: "SkitContractError" },
])("classifies current response $status as $tag", ({ status, body, tag }) =>
  Effect.gen(function* () {
    let requests = 0;
    const failure = yield* Effect.scoped(
      Effect.gen(function* () {
        const api = yield* authorSyncApi(input);
        return yield* api.remote.current;
      }),
    ).pipe(
      Effect.provide(
        registryHttpLayer(
          testHttpClientLayer(() => {
            requests++;
            return Effect.succeed(Response.json(body, { status }));
          }),
        ),
      ),
      Effect.flip,
    );
    expect(failure).toMatchObject({ _tag: tag });
    assert.strictEqual(requests, 1);
  }),
);

it.effect("a stale current move returns the observed revision without retrying", () =>
  Effect.gen(function* () {
    const id = History.RevisionId.make(`sha256:${"a".repeat(64)}`);
    let requests = 0;
    const failure = yield* Effect.scoped(
      Effect.gen(function* () {
        const api = yield* authorSyncApi(input);
        return yield* api.remote.move(null, id);
      }),
    ).pipe(
      Effect.provide(
        registryHttpLayer(
          testHttpClientLayer(() => {
            requests++;
            return Effect.succeed(
              Response.json({ error: "REVISION_CONFLICT", current: id }, { status: 409 }),
            );
          }),
        ),
      ),
      Effect.flip,
    );
    expect(failure).toMatchObject({ _tag: "Sync.Moved", current: id });
    assert.strictEqual(requests, 1);
  }),
);
