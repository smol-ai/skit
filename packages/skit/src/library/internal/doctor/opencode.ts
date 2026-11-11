import { Effect, FileSystem, Option, Schedule, Schema, Stream } from "effect";
import { randomBytes } from "node:crypto";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HarnessDiscoveryFailed } from "../../../harnesses/discovery-failures.js";

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
        Stream.empty.pipe(
          Stream.run(child.stdin),
          Effect.ignore,
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
                new HarnessDiscoveryFailed({
                  harness: "opencode",
                  cwd,
                  reason: {
                    _tag: "OutputLimitExceeded",
                    phase: "startup",
                    limitBytes: 32_000,
                    actualBytes: size,
                  },
                }),
              )
            : Effect.succeed(chunk);
        }),
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => Boolean(line.trim())),
        Stream.mapEffect((line) => Schema.decodeEffect(Schema.fromJsonString(Ready))(line)),
        Stream.runHead,
      );
      if (Option.isNone(ready))
        return yield* new HarnessDiscoveryFailed({
          harness: "opencode",
          cwd,
          reason: { _tag: "ResponseMissing", method: "serve", ...(stderr ? { stderr } : {}) },
        });
      const url = new URL(ready.value.url);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.username ||
        url.password
      )
        return yield* new HarnessDiscoveryFailed({
          harness: "opencode",
          cwd,
          reason: {
            _tag: "ServerAddressInvalid",
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            hasUsername: Boolean(url.username),
            hasPassword: Boolean(url.password),
          },
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
          return yield* new HarnessDiscoveryFailed({
            harness: "opencode",
            cwd,
            reason: { _tag: "HttpStatus", endpoint, status: response.status },
          });
        let bytes = 0;
        return yield* response.stream.pipe(
          Stream.mapEffect((chunk) => {
            bytes += chunk.length;
            return bytes > 4_000_000
              ? Effect.fail(
                  new HarnessDiscoveryFailed({
                    harness: "opencode",
                    cwd,
                    reason: {
                      _tag: "OutputLimitExceeded",
                      phase: "inventory",
                      endpoint,
                      limitBytes: 4_000_000,
                      actualBytes: bytes,
                    },
                  }),
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
        const report = yield* Schema.decodeEffect(Schema.fromJsonString(envelope(Plugins)))(
          yield* read("/api/plugin"),
        );
        if (report.location.directory !== directory)
          return yield* new HarnessDiscoveryFailed({
            harness: "opencode",
            cwd,
            reason: {
              _tag: "DirectoryMismatch",
              endpoint: "/api/plugin",
              expected: directory,
              actual: report.location.directory,
            },
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
        const report = yield* Schema.decodeEffect(Schema.fromJsonString(envelope(Skills)))(
          yield* read("/api/skill"),
        );
        if (report.location.directory !== directory)
          return yield* new HarnessDiscoveryFailed({
            harness: "opencode",
            cwd,
            reason: {
              _tag: "DirectoryMismatch",
              endpoint: "/api/skill",
              expected: directory,
              actual: report.location.directory,
            },
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
          new HarnessDiscoveryFailed({
            harness: "opencode",
            cwd,
            reason: { _tag: "TimedOut", timeoutMs: 20_000 },
          }),
        ),
    }),
  );
});
