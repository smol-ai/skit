import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, ConfigProvider, Layer, Deferred, Fiber } from "effect";
import { NodeServices } from "@effect/platform-node";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  defaultChannel,
  decideRelease,
  ReleaseChecker,
  releaseCheckerLayer,
} from "../src/releases/checker.js";
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
      const layer = releaseCheckerLayer.pipe(
        // Replace the transport at the adapter boundary.
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      );
      const config = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          XDG_STATE_HOME: root,
          SKIT_NPM_REGISTRY: "https://example.test",
        }),
      );
      yield* Effect.gen(function* () {
        const checker = yield* ReleaseChecker;
        expect((yield* checker.notice(release("0.1.0")))?.status).toBe("update-available");
        expect(yield* checker.notice(release("0.1.0"))).toBeUndefined();
        expect(calls).toBe(1);
        yield* TestClock.adjust("24 hours");
        failure = true;
        expect((yield* checker.check(release("0.1.0"), true)).status).toBe("check-unavailable");
        yield* checker.check(release("0.1.0"), false);
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
        const checker = yield* ReleaseChecker;
        const pending = yield* checker.check(release("0.1.0"), false).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* TestClock.adjust("1500 millis");
        expect((yield* Fiber.join(pending)).status).toBe("check-unavailable");
        expect((yield* checker.check(release("0.1.0"), false)).status).toBe("check-unavailable");
        expect(calls).toBe(1);
        yield* TestClock.adjust("24 hours");
        started = yield* Deferred.make<void>();
        const retry = yield* checker.check(release("0.1.0"), false).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* TestClock.adjust("1500 millis");
        yield* Fiber.join(retry);
        expect(calls).toBe(2);
      }).pipe(
        Effect.provide(
          releaseCheckerLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
        ),
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
        const checker = yield* ReleaseChecker;
        expect(yield* checker.notice(release("0.1.0"))).toBeUndefined();
        expect(yield* checker.notice(release("0.1.0"))).toBeUndefined();
        expect(calls).toBe(0);
        expect((yield* checker.check(release("0.1.0"), true)).status).toBe("update-available");
        expect(calls).toBe(1);
      }).pipe(
        Effect.provide(
          releaseCheckerLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
        ),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_STATE_HOME: `${root}/blocked` })),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ignores corrupt caches, repeats notices after a day, and expires stale successes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const directory = `${root}/skit`;
      yield* fs.makeDirectory(directory);
      const path = `${directory}/releases-${encodeURIComponent("https://example.test")}.json`;
      yield* fs.writeFileString(path, "not json");
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
        const checker = yield* ReleaseChecker;
        expect((yield* checker.notice(release("0.1.0")))?.status).toBe("update-available");
        yield* TestClock.adjust("24 hours");
        expect((yield* checker.notice(release("0.1.0")))?.status).toBe("update-available");
        expect(calls).toBe(2);
        failure = true;
        yield* TestClock.adjust("8 days");
        expect(yield* checker.notice(release("0.1.0"))).toBeUndefined();
        expect(calls).toBe(3);
      }).pipe(
        Effect.provide(
          releaseCheckerLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
        ),
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
