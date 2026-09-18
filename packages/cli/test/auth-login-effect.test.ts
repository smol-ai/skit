// What the native login owns that the promise one did not.
//
// The promise implementation ran its four requests with a bare `fetch` and no owner: an
// interrupted login left the in-flight request to settle on its own. The requests now share the
// workflow's Scope, and the prompts are a service rather than two `p.isCancel` checks.
//
// The behaviour those requests implement is unchanged and is covered by `auth-client.test.ts`;
// these cover only what the conversion introduced.

import { join } from "node:path";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { skitLayer } from "@smolai/skit-core";
import { expect } from "vitest";
import { loginEffect } from "../src/registry/auth.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { fetchTestClientLayer } from "./helpers/http-test-client.js";
import { Prompter } from "../src/presentation/prompter.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";

/** A temporary home on the platform FileSystem, so the suite never reaches node:fs to make one. */
const scratch = (prefix: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectory({ prefix })).pipe(
    Effect.provide(skitLayer),
    Effect.orDie,
  );

/** Ask the platform FileSystem, rather than reaching for node:fs to check one path. */
const exists = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path)).pipe(
    Effect.provide(skitLayer),
    Effect.orDie,
  );

const input = {
  origin: "https://skit.example",
  email: "user@example.test",
  password: "not-stored",
  scopes: ["library:sync"] as const,
};

it.effect("an interrupted login aborts its in-flight request and stores nothing", () =>
  Effect.gen(function* () {
    const home = yield* scratch("skit-login-interrupt-");
    let aborted = false;
    // The fetch double is a plain callback, so readiness is signalled by an unsafe completion.
    const gated = Deferred.makeUnsafe<void>();
    const reached = () => Deferred.doneUnsafe(gated, Effect.void);
    // The sign-in never answers, so the only way out is the interrupt.
    const server = ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(init.signal!.reason);
          },
          { once: true },
        );
        reached();
      })) as typeof fetch;

    const fiber = yield* Effect.forkChild(
      Effect.scoped(
        loginEffect({ ...input, scopes: [...input.scopes], home }).pipe(
          Effect.provide(registryHttpLayer(fetchTestClientLayer(server))),
        ),
      ).pipe(Effect.provide(skitLayer)),
    );
    yield* Deferred.await(gated);
    yield* Fiber.interrupt(fiber);

    // The request belongs to the workflow's Scope, so it is cancelled rather than left running.
    expect(aborted).toBe(true);
    expect(yield* exists(join(home, "auth.json"))).toBe(false);
  }),
);

it.effect("the credential prompts answer from the Prompter and cancel as a typed failure", () =>
  Effect.gen(function* () {
    const answered = yield* makeScriptedInteraction(["user@example.test", "not-stored"]);
    const collected = yield* Effect.gen(function* () {
      const prompter = yield* Prompter;
      return [yield* prompter.text("Email"), yield* prompter.password("Password")];
    }).pipe(Effect.provide(answered.layer));
    expect(collected).toEqual(["user@example.test", "not-stored"]);
    expect((yield* answered.prompts).map((question) => question.message)).toEqual([
      "Email",
      "Password",
    ]);

    const cancelled = yield* makeScriptedInteraction(["cancel"]);
    const failure = yield* Effect.gen(function* () {
      const prompter = yield* Prompter;
      return yield* prompter.password("Password");
    }).pipe(Effect.provide(cancelled.layer), Effect.flip);
    // The handler turns this into SelectionCancelled; the service's job is to name it at all.
    expect(failure).toMatchObject({ _tag: "PromptCancelled", prompt: "Password" });
  }),
);

/** A Registry that answers the exchange, with one stage held open until the test releases it. */
function gatedServer(gate: "mint" | "sign-out", reached: () => void) {
  const seen: Array<{ url: string; method: string }> = [];
  const hold = () => new Promise<Response>(() => {});
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    seen.push({ url, method });
    if (url.endsWith("/.well-known/skit"))
      return Response.json({
        schema: "skit.server.v1",
        download: "/api/skits/{owner}/{slug}/releases/{version}/download",
        scopes: ["library:sync", "authoring:write", "publication:write"],
      });
    if (url.endsWith("/api/auth/sign-in/email"))
      return new Response("{}", {
        status: 200,
        headers: { "set-cookie": "skit-auth.session_token=session-secret; Path=/" },
      });
    if (url.endsWith("/api/tokens") && method === "POST") {
      if (gate === "mint") {
        reached();
        return hold();
      }
      return Response.json(
        {
          token: "skit_pat_secret",
          token_id: "pat_one",
          token_prefix: "skit_pat_secret",
          scopes: ["library:sync"],
        },
        { status: 201 },
      );
    }
    if (url.endsWith("/api/auth/sign-out")) {
      if (gate === "sign-out") {
        reached();
        return hold();
      }
      return Response.json({ success: true });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { fetcher, seen };
}

const interruptedLogin = Effect.fn("test.interruptedLogin")(function* (gate: "mint" | "sign-out") {
  const home = yield* scratch(`skit-login-${gate}-`);
  const gated = Deferred.makeUnsafe<void>();
  const server = gatedServer(gate, () => void Deferred.doneUnsafe(gated, Effect.void));
  const fiber = yield* Effect.forkChild(
    Effect.scoped(
      loginEffect({ ...input, scopes: [...input.scopes], home }).pipe(
        Effect.provide(registryHttpLayer(fetchTestClientLayer(server.fetcher))),
      ),
    ).pipe(Effect.provide(skitLayer)),
  );
  yield* Deferred.await(gated);
  yield* Fiber.interrupt(fiber);
  return { home, seen: server.seen };
});

it.effect("interrupting while the credential is minted still signs the temporary session out", () =>
  Effect.gen(function* () {
    const { home, seen } = yield* interruptedLogin("mint");

    // The promise implementation reached its sign-out because nothing could cancel it. A finalizer
    // is what keeps that true once the workflow is interruptible.
    expect(
      seen.some(
        (request) => request.url.endsWith("/api/auth/sign-out") && request.method === "POST",
      ),
    ).toBe(true);
    expect(yield* exists(join(home, "auth.json"))).toBe(false);
  }),
);

it.effect(
  "interrupting after the credential is minted revokes it, because it was never stored",
  () =>
    Effect.gen(function* () {
      const { home, seen } = yield* interruptedLogin("sign-out");

      expect(
        seen.some(
          (request) => request.url.endsWith("/api/tokens/pat_one") && request.method === "DELETE",
        ),
      ).toBe(true);
      // Nothing was persisted, so nothing survives that the caller could use.
      expect(yield* exists(join(home, "auth.json"))).toBe(false);
    }),
);
