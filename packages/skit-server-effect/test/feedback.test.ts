import { applyD1Migrations, env, reset } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeWebHandler } from "../src/http.js";
import type { RuntimeEnv } from "../src/platform/cloudflare.js";

const webPromise = <A>(evaluate: () => Promise<A>) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- Fetch-compatible Worker handlers are Promise APIs; this test helper owns that host boundary.
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(Effect.orDie);

const prepareDatabase = webPromise(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const allowAll: RateLimit = { limit: async () => ({ success: true }) };

const send = (
  body: unknown,
  runtimeEnv: RuntimeEnv = { ...env, FEEDBACK_RATE_LIMITER: allowAll },
) =>
  webPromise(() =>
    makeWebHandler(runtimeEnv).handler(
      new Request("https://registry.test/api/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "skit-client": "skit/1.2.3; kind=release",
          "cf-connecting-ip": "203.0.113.7",
        },
        body: JSON.stringify(body),
      }),
    ),
  );

const storedFeedback = webPromise(() =>
  env.DB.prepare(
    "SELECT id, message, harness, model, platform, runtime, client FROM feedback",
  ).all(),
).pipe(Effect.map((rows) => rows.results));

const report = {
  message: "`skit add` said the Source was invalid but not which part",
  harness: "claude-code",
  model: "claude-opus-5-5",
  platform: "darwin",
  runtime: "v24.10.1",
};

describe("feedback", () => {
  it.effect("stores a report with the sender's skit-client header", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;

      const response = yield* send(report);
      const body = yield* webPromise(() => response.json<{ id: string; createdAt: string }>());

      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(yield* storedFeedback).toEqual([
        { id: body.id, ...report, client: "skit/1.2.3; kind=release" },
      ]);
    }),
  );

  it.effect("accepts fields a newer client sends that this server does not know", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;

      const response = yield* send({ ...report, transcript: "from a later version" });

      expect(response.status).toBe(201);
      expect(yield* storedFeedback).toHaveLength(1);
    }),
  );

  it.effect("refuses a report without a message and stores nothing", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;

      const response = yield* send({ ...report, message: "" });

      expect(response.status).toBe(400);
      expect(yield* storedFeedback).toEqual([]);
    }),
  );

  it.effect("refuses a report over the size limit", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;

      const response = yield* send({ ...report, message: "x".repeat(20_000) });

      expect(response.status).toBe(400);
      expect(yield* storedFeedback).toEqual([]);
    }),
  );

  it.effect("asks a rate-limited sender to retry later and stores nothing", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;

      const response = yield* send(report, {
        ...env,
        FEEDBACK_RATE_LIMITER: { limit: async () => ({ success: false }) },
      });

      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(yield* storedFeedback).toEqual([]);
    }),
  );

  it.effect("has no feedback route on a deployment without the feedback binding", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;

      const response = yield* send(report, { ...env, FEEDBACK_RATE_LIMITER: undefined });

      expect(response.status).toBe(404);
      expect(yield* storedFeedback).toEqual([]);
    }),
  );
});
