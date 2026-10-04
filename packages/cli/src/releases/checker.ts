import { Clock, Config, Context, Effect, FileSystem, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { gt, prerelease, valid } from "semver";
import { BuildInfo } from "@smolai/skit-core";

class UpdateCheckTimedOut extends Schema.TaggedError<UpdateCheckTimedOut>()(
  "UpdateCheckTimedOut",
  {},
) {}

const DAY = 86_400_000;
export const DistTags = Schema.Record(Schema.String, Schema.String);
export const ReleaseCheck = Schema.Struct({
  status: Schema.Literals([
    "current",
    "update-available",
    "ahead",
    "channel-unavailable",
    "check-unavailable",
    "development-build",
  ]),
  channel: Schema.String,
  source: Schema.String,
  available: Schema.optionalKey(Schema.String),
  checkedAt: Schema.optionalKey(Schema.Number),
  reason: Schema.optionalKey(Schema.String),
  upgrade: Schema.optionalKey(Schema.String),
});
export type ReleaseCheck = typeof ReleaseCheck.Type;
export const VersionReport = Schema.Struct({
  version: Schema.String,
  build: BuildInfo,
  update: ReleaseCheck,
});
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
export const defaultChannel = (version: string): string => {
  const identifier = prerelease(version)?.[0];
  return identifier === "alpha" || identifier === "beta" || identifier === "rc"
    ? identifier
    : "latest";
};
export function decideRelease(
  build: BuildInfo,
  tags: Readonly<Record<string, string>>,
  channel: string,
  source: string,
): ReleaseCheck {
  if (build.kind === "dev") return { status: "development-build", channel, source };
  if (!valid(build.version))
    return {
      status: "check-unavailable",
      channel,
      source,
      reason: "Installed version is not valid SemVer.",
    };
  const selected = tags[channel];
  const stable = tags.latest;
  // A misplaced prerelease on latest must never be offered as a stable upgrade.
  const usable =
    selected && valid(selected) && (channel !== "latest" || !prerelease(selected))
      ? selected
      : undefined;
  let available = usable;
  let target = channel;
  if (
    prerelease(build.version) &&
    stable &&
    valid(stable) &&
    !prerelease(stable) &&
    gt(stable, build.version) &&
    (!available || gt(stable, available))
  ) {
    available = stable;
    target = "latest";
  }
  if (!available) return { status: "channel-unavailable", channel, source };
  const status = gt(available, build.version)
    ? "update-available"
    : gt(build.version, available)
      ? "ahead"
      : "current";
  return {
    status,
    channel,
    source,
    available,
    ...(status === "update-available" ? { upgrade: `npm install -g @smolai/skit@${target}` } : {}),
  };
}
export class ReleaseChecker extends Context.Service<
  ReleaseChecker,
  {
    readonly check: (build: BuildInfo, fresh: boolean) => Effect.Effect<ReleaseCheck>;
    readonly notice: (build: BuildInfo) => Effect.Effect<ReleaseCheck | undefined>;
  }
>()("skit/ReleaseChecker") {}

export const releaseCheckerLayer = Layer.effect(
  ReleaseChecker,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const http = yield* HttpClient.HttpClient;
    const registry = yield* Config.string("SKIT_NPM_REGISTRY").pipe(
      Config.withDefault("https://registry.npmjs.org"),
    );
    const override = yield* Config.string("SKIT_RELEASE_CHANNEL").pipe(Config.withDefault(""));
    const state = yield* Config.string("XDG_STATE_HOME").pipe(
      Config.withDefault(join(homedir(), ".local", "state")),
    );
    const source = `${registry.replace(/\/$/, "")}/-/package/@smolai/skit/dist-tags`;
    const path = join(state, "skit", `releases-${encodeURIComponent(registry)}.json`);
    const read = fs.readFileString(path).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Cache))),
      Effect.map((cache) => (cache.source === source ? cache : undefined)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    const write = Effect.fn("ReleaseChecker.write")(function* (cache: Cache) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      yield* fs.makeDirectory(dirname(path), { recursive: true });
      yield* fs
        .writeFileString(temporary, JSON.stringify(cache))
        .pipe(
          Effect.andThen(fs.rename(temporary, path)),
          Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
        );
    });
    const load = Effect.fn("ReleaseChecker.load")(function* (fresh: boolean) {
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
    const check = Effect.fn("ReleaseChecker.check")(function* (build: BuildInfo, fresh: boolean) {
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
    return ReleaseChecker.of({
      check,
      notice: Effect.fn("ReleaseChecker.notice")(function* (build) {
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
    });
  }),
);

export const releaseCheckerLive = releaseCheckerLayer.pipe(Layer.provide(FetchHttpClient.layer));
