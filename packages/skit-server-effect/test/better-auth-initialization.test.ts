import { BrowserCrypto } from "@effect/platform-browser";
import { D1Client } from "@effect/sql-d1";
import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { makeBetterAuth } from "../src/identity/internal/better-auth.js";
import { databaseLayer } from "../src/platform/cloudflare.js";

it.live("does not publish the cached auth service until its D1 schema check finishes", () =>
  Effect.gen(function* () {
    // oxlint-disable-next-line skit/no-promise-wrappers -- Cloudflare migrations are a Promise-only test-host API.
    yield* Effect.promise(async () => {
      await reset();
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    });
    let markEntered = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const gate = async () => {
      if (paused) return;
      paused = true;
      markEntered();
      await released;
    };
    const statement = (target: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(target, {
        get(target, key) {
          if (key === "bind") return (...values: unknown[]) => statement(target.bind(...values));
          if (key === "all")
            return async () => {
              await gate();
              return target.all();
            };
          if (key === "raw")
            return async () => {
              await gate();
              return target.raw();
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const database = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") return (query: string) => statement(target.prepare(query));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    yield* Effect.gen(function* () {
      const sql = yield* D1Client.D1Client;
      const acquiring = yield* makeBetterAuth(
        {
          database,
          publicAppOrigin: "https://registry.test",
          secret: "skit-initialization-test-secret-at-least-thirty-two-characters",
          registrationMode: "closed",
        },
        sql,
      ).pipe(Effect.forkScoped);
      // oxlint-disable-next-line skit/no-promise-wrappers -- Wait for the Promise-only D1 host callback to reach its gate.
      yield* Effect.promise(() => entered);
      yield* Effect.sleep("20 millis");
      expect(yield* Effect.sync(() => acquiring.pollUnsafe())).toBeUndefined();
      yield* Effect.sync(release);
      const auth = yield* Fiber.join(acquiring);
      expect(yield* auth.getSession(new Headers())).toBeUndefined();
    }).pipe(
      Effect.ensuring(Effect.sync(() => release())),
      Effect.provide(Layer.merge(databaseLayer(database), BrowserCrypto.layer)),
    );
  }).pipe(Effect.scoped),
);
