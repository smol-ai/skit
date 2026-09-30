import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { type LibraryState } from "@smolai/skit-core";
import { probeHarnessEffect } from "../../harness/probe.js";

const NativeSkill = Schema.Struct({
  name: Schema.String,
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

export const CodexDoctorInstance = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
  path: Schema.String,
  canonicalPath: Schema.String,
  scope: Schema.String,
  pluginId: Schema.optionalKey(Schema.String),
  skitManaged: Schema.Boolean,
  documentDigest: Schema.optionalKey(Schema.String),
});
export type CodexDoctorInstance = typeof CodexDoctorInstance.Type;
export const CodexDoctorFinding = Schema.Struct({
  kind: Schema.Literals(["duplicate-name", "display-name-collision"]),
  name: Schema.String,
  documents: Schema.Literals(["identical", "different", "unknown"]),
  instances: Schema.Array(CodexDoctorInstance),
});
export type CodexDoctorFinding = typeof CodexDoctorFinding.Type;
export const CodexDoctorCheck = Schema.Struct({
  status: Schema.Literals(["checked", "missing", "failed", "skipped"]),
  cwd: Schema.String,
  version: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  instances: Schema.Array(CodexDoctorInstance),
  findings: Schema.Array(CodexDoctorFinding),
  errors: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
});
export type CodexDoctorCheck = typeof CodexDoctorCheck.Type;

/** Canonical document identity, not names or visible labels, collapses symlink aliases. */
export function codexDuplicateFindings(
  instances: readonly CodexDoctorInstance[],
): CodexDoctorFinding[] {
  const unique = [...new Map(instances.map((item) => [item.canonicalPath, item])).values()];
  const findings: CodexDoctorFinding[] = [];
  for (const kind of ["duplicate-name", "display-name-collision"] as const) {
    const groups = new Map<string, CodexDoctorInstance[]>();
    for (const item of unique) {
      const key = kind === "duplicate-name" ? item.name : item.displayName;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    for (const [name, group] of groups) {
      if (group.length < 2) continue;
      if (kind === "display-name-collision" && new Set(group.map((item) => item.name)).size < 2)
        continue;
      const hashes = group.map((item) => item.documentDigest);
      findings.push({
        kind,
        name,
        documents: hashes.some((hash) => hash === undefined)
          ? "unknown"
          : new Set(hashes).size === 1
            ? "identical"
            : "different",
        instances: group.sort((a, b) => a.path.localeCompare(b.path)),
      });
    }
  }
  return findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** Native discovery only: no thread, model turn, or skill invocation. The scope kills the server. */
export const readCodexSkills = Effect.fn("Doctor.readCodexSkills")(function* (
  executable: string,
  cwd: string,
  environment?: Readonly<Record<string, string>>,
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
          message.error
            ? Effect.fail(new CodexDoctorFailure({ message: message.error.message }))
            : Effect.succeed(message),
        ),
        Stream.filter((message) => message.id === 2),
        Stream.runHead,
      );
      if (Option.isNone(response))
        return yield* new CodexDoctorFailure({
          message: "Codex exited without a skills/list response",
        });
      const decoded = yield* Schema.decodeUnknownEffect(SkillsResponse)(response.value.result);
      const entry = decoded.data.find((item) => resolve(item.cwd) === resolve(cwd));
      if (!entry)
        return yield* new CodexDoctorFailure({
          message: "Codex omitted the requested working directory",
        });
      return entry;
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

export const doctorCodexCheck = Effect.fn("Doctor.codex")(function* (
  state: LibraryState,
  cwd: string,
  overrideRoot?: string,
) {
  const empty = { cwd, instances: [], findings: [], errors: [] };
  if (overrideRoot)
    return {
      ...empty,
      status: "skipped" as const,
      detail:
        "A custom --codex-root does not describe Codex's configured discovery. Run doctor without that override to check native discovery.",
    };
  const probe = yield* probeHarnessEffect("codex");
  if (probe.status !== "installed" || !probe.executablePath)
    return {
      ...empty,
      status: probe.status === "missing" ? ("missing" as const) : ("failed" as const),
      detail: probe.error ?? "Codex CLI is unavailable",
    };
  const version = probe.version ? { version: probe.version } : {};
  const executable = probe.executablePath;
  return yield* Effect.gen(function* () {
    const entry = yield* readCodexSkills(executable, cwd);
    const fs = yield* FileSystem.FileSystem;
    const managed = new Set(
      yield* Effect.forEach(state.projections, (projection) =>
        fs.realPath(projection.path).pipe(Effect.orElseSucceed(() => resolve(projection.path))),
      ),
    );
    const errors = [...entry.errors];
    const instances = yield* Effect.forEach(
      entry.skills.filter((skill) => skill.enabled),
      (skill) =>
        Effect.gen(function* () {
          const canonicalPath = yield* fs
            .realPath(skill.path)
            .pipe(Effect.orElseSucceed(() => resolve(skill.path)));
          const documentDigest = yield* fs.readFile(skill.path).pipe(
            Effect.map((bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex")),
            Effect.catchTag("PlatformError", () => {
              errors.push({
                path: skill.path,
                message: "Could not read the discovered SKILL.md for content comparison",
              });
              return Effect.succeed(undefined);
            }),
          );
          return {
            name: skill.name,
            displayName: skill.interface?.displayName?.trim() || skill.name,
            path: skill.path,
            canonicalPath,
            scope: skill.scope,
            ...(skill.pluginId ? { pluginId: skill.pluginId } : {}),
            skitManaged: managed.has(dirname(canonicalPath)),
            ...(documentDigest ? { documentDigest } : {}),
          };
        }),
    );
    return {
      ...empty,
      ...version,
      status: "checked" as const,
      instances,
      findings: codexDuplicateFindings(instances),
      errors,
    };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        ...empty,
        ...version,
        status: "failed" as const,
        detail: String(error),
      }),
    ),
  );
});
