import { serverBuild } from "../src/platform/build-info.js";
import { applyD1Migrations, env, reset } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach } from "vitest";
import { makeWebHandler } from "../src/http.js";
import { makeServerDiscovery, serverDiscovery } from "../src/api/discovery.js";

let web: ReturnType<typeof makeWebHandler>;
let releaseOnlyWeb: ReturnType<typeof makeWebHandler>;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  web = makeWebHandler(env);
  releaseOnlyWeb = makeWebHandler(env, {});
});

afterEach(async () => {
  await web.dispose();
  await releaseOnlyWeb.dispose();
});

const fetchEffect = (path: string) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- Fetch-compatible Worker handlers are Promise APIs; this test owns that host boundary.
  Effect.promise(() => web.handler(new Request(`https://registry.test${path}`)));

describe("server discovery", () => {
  it("represents a release-download-only server without write capabilities", () => {
    expect(makeServerDiscovery({})).toEqual({
      schema: "skit.server.v1",
      build: serverBuild,
      download: "/api/skits/{owner}/{slug}/releases/{version}/download",
      scopes: [],
    });
  });
  it.effect("omits uncomposed authenticated capabilities and routes", () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line skit/no-promise-wrappers -- Fetch-compatible Worker handlers are Promise APIs; this test owns that host boundary.
      const discovery = yield* Effect.tryPromise(() =>
        releaseOnlyWeb.handler(new Request("https://registry.test/.well-known/skit")),
      );
      // oxlint-disable-next-line skit/no-promise-wrappers -- Response body decoding is part of the Fetch host boundary under test.
      expect(yield* Effect.tryPromise(() => discovery.json())).toEqual(makeServerDiscovery({}));

      // oxlint-disable-next-line skit/no-promise-wrappers -- Fetch-compatible Worker handlers are Promise APIs; this test owns that host boundary.
      const skit = yield* Effect.tryPromise(() =>
        releaseOnlyWeb.handler(
          new Request("https://registry.test/api/skits/alice/tools/skit", { method: "GET" }),
        ),
      );
      expect(skit.status).toBe(404);
    }).pipe(Effect.orDie),
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
