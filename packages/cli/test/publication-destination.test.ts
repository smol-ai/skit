import { PublicationResponseError } from "../src/registry/request-failures.js";
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { RegistryHttp, registryHttpLayer } from "../src/registry/registry-http.js";
import { publishRelease } from "../src/registry/publication.js";
import { testHttpClientLayer } from "./helpers/http-test-client.js";

const upload = (origin: string) =>
  Effect.gen(function* () {
    const http = yield* (yield* RegistryHttp).client;
    return yield* publishRelease(http, {
      remote: { schema: "skit.remote.v1", origin, namespace: "test", skit: "tools" },
      token: "dummy-publication-token",
      root: "/unused",
      version: "1.0.0",
      archive: new Uint8Array([1]),
    });
  });

it.effect.each([
  "https://other.invalid/upload",
  "//other.invalid/upload",
  "http://registry.test/upload",
  "https://registry.test:444/upload",
  "file:///tmp/upload",
  "https://[broken",
  "blob:https://registry.test/upload",
  "https://user:pass@registry.test/upload",
  "/upload#fragment",
])("discovery refuses credential destination %s before uploading", (publish) =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const failure = yield* upload("https://registry.test").pipe(
      Effect.provide(
        registryHttpLayer(
          testHttpClientLayer((request) => {
            requests.push(request.url);
            expect(request.headers.authorization).toBeUndefined();
            return Effect.succeed(Response.json({ publish }));
          }),
        ),
      ),
      Effect.flip,
    );
    expect(failure).toMatchObject({
      _tag: "PublicationResponseError",
      reason: { _tag: "DestinationInvalid", origin: "https://registry.test" },
    });
    if (failure._tag !== "PublicationResponseError" || failure.reason._tag !== "DestinationInvalid")
      throw new Error("Missing destination rejection");
    const destination = URL.parse(publish, "https://registry.test");
    if (destination === null) expect(failure.reason.issues).toContain("malformed-url");
    else {
      if (destination.origin !== "https://registry.test")
        expect(failure.reason.issues).toContain("different-origin");
      if (destination.username || destination.password)
        expect(failure.reason.issues).toContain("credentials");
      if (destination.hash) expect(failure.reason.issues).toContain("fragment");
      if (!["https:", "http:"].includes(destination.protocol))
        expect(failure.reason.issues).toContain("scheme");
    }
    const wire = JSON.stringify(Schema.encodeSync(PublicationResponseError)(failure));
    expect(wire).not.toContain("user:pass");
    expect(wire).not.toContain("#fragment");
    expect(requests).toEqual(["https://registry.test/.well-known/agent-skills/"]);
  }).pipe(Effect.scoped),
);

it.effect.each(
  [
    ["https://registry.test", "/upload/{owner}/{slug}", "https://registry.test/upload/test/tools"],
    ["https://registry.test", "https://registry.test/upload", "https://registry.test/upload"],
    ["http://localhost:1234", "/upload", "http://localhost:1234/upload"],
    ["http://127.0.0.1:1234", "/upload", "http://127.0.0.1:1234/upload"],
    ["https://registry.test", undefined, "https://registry.test/api/skits/test/tools/releases"],
  ].map(([origin, publish, expected]) => ({ origin: origin!, publish, expected })),
)(
  "publication uses selected Registry $origin and destination $publish",
  ({ origin, publish, expected }) =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const response = yield* upload(origin).pipe(
        Effect.provide(
          registryHttpLayer(
            testHttpClientLayer((request) => {
              requests.push(request.url);
              if (request.method === "GET") {
                expect(request.headers.authorization).toBeUndefined();
                return Effect.succeed(
                  publish === undefined
                    ? new Response(null, { status: 404 })
                    : Response.json({ publish }),
                );
              }
              expect(request.url).toBe(expected);
              expect(request.headers.authorization).toBe("Bearer dummy-publication-token");
              return Effect.succeed(
                Response.json(
                  {
                    release: {
                      release_id: "rel_1",
                      version: "1.0.0",
                      archive_digest: `sha256:${"a".repeat(64)}`,
                      download_path: "/api/skits/test/tools/releases/1.0.0/download",
                    },
                  },
                  { status: 201 },
                ),
              );
            }),
          ),
        ),
      );
      expect(response.release.version).toBe("1.0.0");
      expect(requests.at(-1)).toBe(expected);
    }).pipe(Effect.scoped),
);

it.effect("insecure remote is refused before discovery", () =>
  Effect.gen(function* () {
    let requests = 0;
    const error = yield* upload("http://registry.test").pipe(
      Effect.provide(
        registryHttpLayer(
          testHttpClientLayer(() => {
            requests++;
            return Effect.succeed(new Response(null, { status: 404 }));
          }),
        ),
      ),
      Effect.flip,
    );
    expect(error).toMatchObject({ _tag: "PublicationResponseError" });
    expect(requests).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("publication disables redirects in its transport configuration", () =>
  Effect.gen(function* () {
    let uploaded = false;
    const error = yield* upload("https://registry.test").pipe(
      Effect.provide(
        registryHttpLayer(
          testHttpClientLayer((request) =>
            Effect.gen(function* () {
              if (request.method === "GET") return new Response(null, { status: 404 });
              const options = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
              expect(Option.getOrUndefined(options)?.redirect).toBe("error");
              uploaded = true;
              return new Response(null, {
                status: 302,
                headers: { location: "https://other.invalid/upload" },
              });
            }),
          ),
        ),
      ),
      Effect.flip,
    );
    expect(uploaded).toBe(true);
    expect(error).toMatchObject({ _tag: "PublicationResponseError" });
  }).pipe(Effect.scoped),
);
