import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeWebHandler } from "../src/http.js";
import { makeServerDiscovery, serverDiscovery } from "../src/discovery.js";

const web = makeWebHandler(env);
const releaseOnlyWeb = makeWebHandler(env, {});

const fetchEffect = (path: string) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- Fetch-compatible Worker handlers are Promise APIs; this test owns that host boundary.
  Effect.tryPromise({
    try: () => web.handler(new Request(`https://registry.test${path}`)),
    catch: (cause) => cause,
  }).pipe(Effect.orDie);

describe("server discovery", () => {
  it("represents a release-download-only server without write capabilities", () => {
    expect(makeServerDiscovery({})).toEqual({
      schema: "skit.server.v1",
      download: "/api/skits/{owner}/{slug}/releases/{version}/download",
      scopes: [],
    });
  });
  it.effect("omits uncomposed authenticated capabilities and routes", () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line skit/no-promise-wrappers -- Fetch-compatible Worker handlers are Promise APIs; this test owns that host boundary.
      const discovery = yield* Effect.tryPromise(() =>
        releaseOnlyWeb.handler(new Request("https://registry.test/.well-known/skit")),
      ).pipe(Effect.orDie);
      // oxlint-disable-next-line skit/no-promise-wrappers -- Response body decoding is part of the Fetch host boundary under test.
      expect(yield* Effect.tryPromise(() => discovery.json()).pipe(Effect.orDie)).toEqual(
        makeServerDiscovery({}),
      );

      // oxlint-disable-next-line skit/no-promise-wrappers -- Fetch-compatible Worker handlers are Promise APIs; this test owns that host boundary.
      const draft = yield* Effect.tryPromise(() =>
        releaseOnlyWeb.handler(
          new Request("https://registry.test/api/skits/alice/tools/draft", { method: "GET" }),
        ),
      ).pipe(Effect.orDie);
      expect(draft.status).toBe(404);
    }),
  );
  for (const path of ["/.well-known/agent-skills/", "/.well-known/skit"]) {
    it.effect(`serves the versioned contract at ${path}`, () =>
      Effect.gen(function* () {
        const response = yield* fetchEffect(path);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        // oxlint-disable-next-line skit/no-promise-wrappers -- Response body decoding is part of the Fetch host boundary under test.
        const body = yield* Effect.tryPromise(() => response.json()).pipe(Effect.orDie);
        expect(body).toEqual(serverDiscovery);
      }),
    );
  }
});
