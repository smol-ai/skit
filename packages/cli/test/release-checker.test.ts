import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, ConfigProvider, Layer, Deferred, Fiber } from "effect";
import {
  skitConfigurationLayer,
  SkitConfiguration,
  resolveSkitConfiguration,
} from "@smolai/skit-core/platform";
import { NodeServices } from "@effect/platform-node";
import { HttpClient, HttpClientResponse } from "effect/http";
import { defaultChannel, decideRelease } from "../src/releases.js";
import { checkRelease, noticeRelease } from "../src/platform/releases.js";
const releaseContext = (http: HttpClient.HttpClient) =>
  Layer.merge(Layer.succeed(HttpClient.HttpClient, http), skitConfigurationLayer());

const release = (version: string) => ({ kind: "release" as const, version, commit: "abc" });

describe("release decisions", () => {
  it("compares numeric prerelease identifiers and keeps channels separate", () => {
    expect(defaultChannel("0.3.0-beta.2")).toBe("beta");
    expect(
      decideRelease(
        release("0.3.0-beta.2"),
        { beta: "0.3.0-beta.10", rc: "0.3.0-rc.1" },
        "beta",
        "npm",
      ).available,
    ).toBe("0.3.0-beta.10");
  });
  it("offers a newer stable release but never a prerelease on latest", () => {
    expect(
      decideRelease(release("0.3.0-rc.1"), { latest: "0.3.0" }, "rc", "npm").upgrade,
    ).toContain("@latest");
    expect(
      decideRelease(release("0.2.0"), { latest: "0.3.0-alpha.1" }, "latest", "npm").status,
    ).toBe("channel-unavailable");
    expect(decideRelease(release("0.3.0-beta.1"), { latest: "0.2.5" }, "beta", "npm").status).toBe(
      "channel-unavailable",
    );
  });
  it("does not offer downgrades or compare development builds", () => {
    expect(decideRelease(release("0.3.0"), { latest: "0.2.0" }, "latest", "npm").status).toBe(
      "ahead",
    );
    expect(
      decideRelease({ kind: "dev", version: "0.1.0" }, { latest: "1.0.0" }, "latest", "npm").status,
    ).toBe("development-build");
  });
});

it.effect("persists successful checks, deduplicates notices, and backs off failed refreshes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      let calls = 0;
      let failure = false;
      const http = HttpClient.make((request) => {
        calls++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(failure ? "{}" : '{"latest":"1.0.0"}', { status: failure ? 503 : 200 }),
          ),
        );
      });
      const layer = releaseContext(http);
      const config = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          XDG_STATE_HOME: root,
          SKIT_NPM_REGISTRY: "https://example.test",
        }),
      );
      yield* Effect.gen(function* () {
        expect((yield* noticeRelease(release("0.1.0")))?.status).toBe("update-available");
        expect(yield* noticeRelease(release("0.1.0"))).toBeUndefined();
        expect(calls).toBe(1);
        yield* TestClock.adjust("24 hours");
        failure = true;
        expect((yield* checkRelease(release("0.1.0"), true)).status).toBe("check-unavailable");
        yield* checkRelease(release("0.1.0"), false);
        expect(calls).toBe(2);
      }).pipe(Effect.provide(layer), Effect.provide(config));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("records a timeout as a failed attempt and retries after the daily backoff", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      let started = yield* Deferred.make<void>();
      let calls = 0;
      const http = HttpClient.make(() => {
        calls++;
        return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
      });
      yield* Effect.gen(function* () {
        const pending = yield* checkRelease(release("0.1.0"), false).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* TestClock.adjust("1500 millis");
        expect((yield* Fiber.join(pending)).status).toBe("check-unavailable");
        expect((yield* checkRelease(release("0.1.0"), false)).status).toBe("check-unavailable");
        expect(calls).toBe(1);
        yield* TestClock.adjust("24 hours");
        started = yield* Deferred.make<void>();
        const retry = yield* checkRelease(release("0.1.0"), false).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* TestClock.adjust("1500 millis");
        yield* Fiber.join(retry);
        expect(calls).toBe(2);
      }).pipe(
        Effect.provide(releaseContext(http)),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_STATE_HOME: root }))),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("skips passive network access when state cannot be persisted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${root}/blocked`, "file instead of directory");
      let calls = 0;
      const http = HttpClient.make((request) => {
        calls++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response('{"latest":"1.0.0"}')),
        );
      });
      yield* Effect.gen(function* () {
        expect(yield* noticeRelease(release("0.1.0"))).toBeUndefined();
        expect(yield* noticeRelease(release("0.1.0"))).toBeUndefined();
        expect(calls).toBe(0);
        expect((yield* checkRelease(release("0.1.0"), true)).status).toBe("update-available");
        expect(calls).toBe(1);
      }).pipe(
        Effect.provide(releaseContext(http)),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_STATE_HOME: `${root}/blocked` })),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["not json", "non-finite timestamp"])(
  "ignores corrupt caches (%s), repeats notices after a day, and expires stale successes",
  (corruption) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const directory = `${root}/skit`;
        yield* fs.makeDirectory(directory);
        const path = `${directory}/releases-${encodeURIComponent("https://example.test")}.json`;
        yield* fs.writeFileString(
          path,
          corruption === "not json"
            ? "not json"
            : '{"schema":"skit.release-cache.v1","source":"https://example.test/-/package/@smolai/skit/dist-tags","attemptedAt":0,"succeededAt":0,"notifiedVersion":"1.0.0","notifiedAt":1e999,"tags":{"latest":"1.0.0"}}',
        );
        let calls = 0;
        let failure = false;
        const http = HttpClient.make((request) => {
          calls++;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response('{"latest":"1.0.0"}', { status: failure ? 503 : 200 }),
            ),
          );
        });
        yield* Effect.gen(function* () {
          expect((yield* noticeRelease(release("0.1.0")))?.status).toBe("update-available");
          yield* TestClock.adjust("24 hours");
          expect((yield* noticeRelease(release("0.1.0")))?.status).toBe("update-available");
          expect(calls).toBe(2);
          failure = true;
          yield* TestClock.adjust("8 days");
          expect(yield* noticeRelease(release("0.1.0"))).toBeUndefined();
          expect(calls).toBe(3);
        }).pipe(
          Effect.provide(releaseContext(http)),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                XDG_STATE_HOME: root,
                SKIT_NPM_REGISTRY: "https://example.test",
              }),
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("uses the supplied application state directory instead of rereading XDG", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const configuration = yield* resolveSkitConfiguration(undefined, root);
      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response('{"latest":"1.0.0"}'))),
      );
      const checked = yield* checkRelease(release("0.1.0"), true).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(SkitConfiguration, {
          ...configuration,
          stateHome: `${root}/configured`,
        }),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              XDG_STATE_HOME: `${root}/changed`,
              SKIT_NPM_REGISTRY: "https://example.test",
            }),
          ),
        ),
      );
      expect(checked.status).toBe("update-available");
      expect(
        yield* fs.exists(
          `${root}/configured/skit/releases-${encodeURIComponent("https://example.test")}.json`,
        ),
      ).toBe(true);
      expect(yield* fs.exists(`${root}/changed`)).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
