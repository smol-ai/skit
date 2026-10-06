import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { resolve } from "node:path";

const NativeSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  path: Schema.String,
  scope: Schema.String,
  enabled: Schema.Boolean,
  pluginId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  interface: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const SkillsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      cwd: Schema.String,
      skills: Schema.Array(NativeSkill),
      errors: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
    }),
  ),
});
const Envelope = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});

export class CodexDoctorFailure extends Schema.TaggedError<CodexDoctorFailure>()(
  "CodexDoctorFailure",
  { message: Schema.String },
) {}

/** Native discovery only: no thread, model turn, or skill invocation. The scope kills the server. */
export const readCodexSkills = Effect.fn("Doctor.readCodexSkills")(function* (
  executable: string,
  cwd: string,
  environment?: Readonly<Record<string, string>>,
  includeConfig = false,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const requests = [
    {
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "skit_doctor", version: "0.1.0" } },
    },
    { method: "initialized" },
    { id: 2, method: "skills/list", params: { cwds: [cwd], forceReload: true } },
    ...(includeConfig ? [{ id: 3, method: "config/read", params: { cwd } }] : []),
  ];
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, ["app-server"], {
          cwd,
          extendEnv: true,
          env: environment,
          stdin: {
            stream: Stream.succeed(
              new TextEncoder().encode(
                requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
              ),
            ),
            endOnDone: false,
          },
          stderr: "ignore",
        }),
      );
      let size = 0;
      const response = yield* child.stdout.pipe(
        Stream.mapEffect((chunk) => {
          size += chunk.length;
          return size > 4_000_000
            ? Effect.fail(
                new CodexDoctorFailure({ message: "Codex skill discovery exceeded 4 MB" }),
              )
            : Effect.succeed(chunk);
        }),
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0),
        Stream.mapEffect((line) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope))(line),
        ),
        Stream.mapEffect((message) =>
          message.error && !(includeConfig && message.id === 3)
            ? Effect.fail(new CodexDoctorFailure({ message: message.error.message }))
            : Effect.succeed(message),
        ),
        Stream.filter((message) => message.id === 2 || (includeConfig && message.id === 3)),
        Stream.take(includeConfig ? 2 : 1),
        Stream.runCollect,
      );
      const skillsResponse = response.find((message) => message.id === 2);
      if (!skillsResponse)
        return yield* new CodexDoctorFailure({
          message: "Codex exited without a skills/list response",
        });
      const decoded = yield* Schema.decodeUnknownEffect(SkillsResponse)(skillsResponse.result);
      const entry = decoded.data.find((item) => resolve(item.cwd) === resolve(cwd));
      if (!entry)
        return yield* new CodexDoctorFailure({
          message: "Codex omitted the requested working directory",
        });
      const config = response.find((message) => message.id === 3)?.result;
      const configError = response.find((message) => message.id === 3)?.error?.message;
      return {
        ...entry,
        ...(includeConfig
          ? {
              config,
              ...(config === undefined
                ? { configError: configError ?? "Codex exited without a config/read response" }
                : {}),
            }
          : {}),
      };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: 10_000,
      orElse: () =>
        Effect.fail(
          new CodexDoctorFailure({ message: "Codex skill discovery timed out after 10 seconds" }),
        ),
    }),
  );
});
