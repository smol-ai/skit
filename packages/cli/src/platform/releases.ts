import { Data, Clock, Config, Effect, FileSystem, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { type BuildInfo, FailureTypeId, type SkitFailure } from "@smolai/skit-core/shared";
import { SkitConfiguration } from "@smolai/skit-core/platform";

import { defaultChannel, decideRelease, type ReleaseCheck } from "../releases.js";

class UpdateCheckTimedOut
  extends Data.TaggedError("UpdateCheckTimedOut")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Retry when the network is available.";
  get message(): string {
    return "The release check timed out";
  }
}

const DAY = 86_400_000;
const DistTags = Schema.Record(Schema.String, Schema.String);
const Cache = Schema.Struct({
  schema: Schema.Literal("skit.release-cache.v1"),
  source: Schema.String,
  attemptedAt: Schema.Number,
  succeededAt: Schema.optionalKey(Schema.Number),
  tags: DistTags,
  notifiedVersion: Schema.optionalKey(Schema.String),
  notifiedAt: Schema.optionalKey(Schema.Number),
});
type Cache = typeof Cache.Type;
const makeReleaseNotice = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const registry = yield* Config.String("SKIT_NPM_REGISTRY").pipe(
    Config.withDefault("https://registry.npmjs.org"),
  );
  const override = yield* Config.String("SKIT_RELEASE_CHANNEL").pipe(Config.withDefault(""));
  const { stateHome: state } = yield* SkitConfiguration;
  const source = `${registry.replace(/\/$/, "")}/-/package/@smolai/skit/dist-tags`;
  const path = join(state, "skit", `releases-${encodeURIComponent(registry)}.json`);
  const read = fs.readFileString(path).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Cache))),
    Effect.map((cache) => (cache.source === source ? cache : undefined)),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  const write = Effect.fn("ReleaseNotice.write")(function* (cache: Cache) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    yield* fs.makeDirectory(dirname(path), { recursive: true });
    yield* fs
      .writeFileString(temporary, JSON.stringify(cache))
      .pipe(
        Effect.andThen(fs.rename(temporary, path)),
        Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
      );
  });
  const load = Effect.fn("ReleaseNotice.load")(function* (fresh: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const cache = yield* read;
    if (!fresh && cache && cache.attemptedAt <= now && now - cache.attemptedAt < DAY)
      return { cache, now, reason: undefined };
    // Passive checks require writable persistence; otherwise every invocation would
    // repeat the network delay and notice. Explicit checks remain available.
    if (!fresh) {
      const writable = yield* write(
        cache ?? { schema: "skit.release-cache.v1", source, attemptedAt: now - DAY, tags: {} },
      ).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (!writable) return { cache: undefined, now, reason: "Update cache is not writable." };
    }
    const fetched = yield* Effect.scoped(
      http
        .get(source)
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(DistTags)),
        ),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "1500 millis",
        orElse: () => Effect.fail(new UpdateCheckTimedOut()),
      }),
      Effect.map((tags) => ({ tags, reason: undefined })),
      Effect.catch((error) => Effect.succeed({ tags: undefined, reason: String(error) })),
    );
    const updated: Cache = {
      schema: "skit.release-cache.v1",
      source,
      attemptedAt: now,
      tags: fetched.tags ?? cache?.tags ?? {},
      ...(fetched.tags
        ? { succeededAt: now }
        : cache?.succeededAt !== undefined
          ? { succeededAt: cache.succeededAt }
          : {}),
      ...(cache?.notifiedVersion
        ? { notifiedVersion: cache.notifiedVersion, notifiedAt: cache.notifiedAt }
        : {}),
    };
    yield* write(updated).pipe(Effect.ignore);
    return { cache: updated, now, reason: fetched.reason };
  });
  const check = Effect.fn("ReleaseNotice.check")(function* (build: BuildInfo, fresh: boolean) {
    const { cache, now, reason } = yield* load(fresh);
    const channel = override || defaultChannel(build.version);
    if (
      !cache ||
      (fresh && reason) ||
      cache.succeededAt === undefined ||
      cache.succeededAt > now ||
      now - cache.succeededAt > 7 * DAY
    ) {
      return {
        status: "check-unavailable",
        channel,
        source,
        reason: reason ?? "No recent successful update check.",
      } satisfies ReleaseCheck;
    }
    return { ...decideRelease(build, cache.tags, channel, source), checkedAt: cache.succeededAt };
  });
  return {
    check,
    notice: Effect.fn("ReleaseNotice.notice")(function* (build: BuildInfo) {
      const checked = yield* check(build, false);
      if (checked.status !== "update-available") return undefined;
      const now = yield* Clock.currentTimeMillis;
      const cache = yield* read;
      if (
        cache &&
        cache.notifiedVersion === checked.available &&
        cache.notifiedAt !== undefined &&
        cache.notifiedAt <= now &&
        now - cache.notifiedAt < DAY
      )
        return undefined;
      if (!cache) return undefined;
      const saved = yield* write({
        ...cache,
        notifiedVersion: checked.available,
        notifiedAt: now,
      }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (!saved) return undefined;
      return checked;
    }),
  };
});

export const checkRelease = Effect.fn("ReleaseNotice.checkRelease")(function* (
  build: BuildInfo,
  fresh: boolean,
) {
  const owner = yield* makeReleaseNotice;
  return yield* owner.check(build, fresh);
});

export const noticeRelease = Effect.fn("ReleaseNotice.noticeRelease")(function* (build: BuildInfo) {
  const owner = yield* makeReleaseNotice;
  return yield* owner.notice(build);
});
