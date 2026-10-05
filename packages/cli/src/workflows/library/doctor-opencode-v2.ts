import { Effect, FileSystem, Option, Schedule, Schema, Stream } from "effect";
import { randomBytes } from "node:crypto";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class OpenCodeDiscoveryFailure extends Schema.TaggedError<OpenCodeDiscoveryFailure>()(
  "OpenCodeDiscoveryFailure",
  { message: Schema.String },
) {}
const Ready = Schema.Struct({ url: Schema.String });
const Plugins = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    state: Schema.Struct({ status: Schema.String }),
  }),
);
const Skills = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.optionalKey(Schema.String),
    path: Schema.String,
  }),
);
const envelope = <S extends Schema.Top>(data: S) =>
  Schema.Struct({
    location: Schema.Struct({ directory: Schema.String }),
    data,
  });
const requiredPlugins = [
  "opencode.skill",
  "opencode.config.compatibility",
  "opencode.config.skill",
];

/** V2.0.20 native inventory: no model turn; the stdin lease owns server lifetime. */
export const readOpenCodeV2Skills = Effect.fn("Doctor.readOpenCodeV2Skills")(function* (
  executable: string,
  cwd: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(cwd);
      const password = randomBytes(32).toString("hex");
      const child = yield* spawner.spawn(
        ChildProcess.make(
          executable,
          [
            "serve",
            "--stdio",
            "--hostname",
            "127.0.0.1",
            "--port",
            "0",
            "--log-level",
            "warn",
            "--print-logs",
          ],
          {
            cwd: directory,
            env: {
              OPENCODE_PASSWORD: password,
              OPENCODE_USERNAME: "opencode",
              OPENCODE_DISABLE_MODELS_FETCH: "1",
            },
            extendEnv: true,
            stdin: "pipe",
            forceKillAfter: "2 seconds",
          },
        ),
      );
      yield* Effect.addFinalizer(() =>
        Stream.empty.pipe(Stream.run(child.stdin), Effect.ignore).pipe(
          Effect.andThen(
            child.exitCode.pipe(
              Effect.timeoutOrElse({
                duration: 2_000,
                orElse: () => child.kill({ killSignal: "SIGKILL" }),
              }),
            ),
          ),
          Effect.ignore,
        ),
      );
      let stderr = "";
      yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            stderr = (stderr + chunk).slice(-32_000);
          }),
        ),
        Effect.forkScoped,
      );
      let size = 0;
      const ready = yield* child.stdout.pipe(
        Stream.mapEffect((chunk) => {
          size += chunk.length;
          return size > 32_000
            ? Effect.fail(
                new OpenCodeDiscoveryFailure({ message: "OpenCode startup exceeded 32 KB" }),
              )
            : Effect.succeed(chunk);
        }),
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => Boolean(line.trim())),
        Stream.mapEffect((line) => Schema.decodeUnknownEffect(Schema.fromJsonString(Ready))(line)),
        Stream.runHead,
      );
      if (Option.isNone(ready))
        return yield* new OpenCodeDiscoveryFailure({
          message: "OpenCode exited before server readiness",
        });
      const url = new URL(ready.value.url);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.username ||
        url.password
      )
        return yield* new OpenCodeDiscoveryFailure({
          message: "OpenCode returned an unexpected server address",
        });
      const client = yield* HttpClient.HttpClient;
      const read = Effect.fn("Doctor.OpenCodeV2.get")(function* (endpoint: string) {
        const response = yield* client.execute(
          HttpClientRequest.get(`${url.origin}${endpoint}`).pipe(
            HttpClientRequest.setHeader(
              "authorization",
              `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
            ),
          ),
        );
        if (response.status !== 200)
          return yield* new OpenCodeDiscoveryFailure({
            message: `OpenCode ${endpoint} returned HTTP ${response.status}`,
          });
        let bytes = 0;
        return yield* response.stream.pipe(
          Stream.mapEffect((chunk) => {
            bytes += chunk.length;
            return bytes > 4_000_000
              ? Effect.fail(
                  new OpenCodeDiscoveryFailure({ message: "OpenCode discovery exceeded 4 MB" }),
                )
              : Effect.succeed(chunk);
          }),
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
        );
      });
      const active = Effect.gen(function* () {
        const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(envelope(Plugins)))(
          yield* read("/api/plugin"),
        );
        if (report.location.directory !== directory)
          return yield* new OpenCodeDiscoveryFailure({
            message: "OpenCode inventory belongs to another directory",
          });
        return requiredPlugins.every((id) =>
          report.data.some((plugin) => plugin.id === id && plugin.state.status === "active"),
        );
      });
      yield* active.pipe(
        Effect.repeat({ schedule: Schedule.spaced("50 millis"), while: (ready) => !ready }),
      );
      let previous = "";
      let stable = 0;
      const inventory = Effect.gen(function* () {
        const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(envelope(Skills)))(
          yield* read("/api/skill"),
        );
        if (report.location.directory !== directory)
          return yield* new OpenCodeDiscoveryFailure({
            message: "OpenCode inventory belongs to another directory",
          });
        const snapshot = JSON.stringify([...report.data].sort((a, b) => a.id.localeCompare(b.id)));
        stable = snapshot === previous ? stable + 1 : 1;
        previous = snapshot;
        return report;
      });
      const report = yield* inventory.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("50 millis"),
          while: () => stable < 3,
        }),
      );
      return {
        skills: report.data.map((skill) => ({ ...skill, warnings: [], errors: [] })),
        warnings: stderr.split("\n").filter((line) => /level=(WARN|ERROR|FATAL)\b/.test(line)),
      };
    }),
  ).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.timeoutOrElse({
      duration: 20_000,
      orElse: () =>
        Effect.fail(
          new OpenCodeDiscoveryFailure({
            message: "OpenCode v2 discovery timed out after 20 seconds",
          }),
        ),
    }),
  );
});
