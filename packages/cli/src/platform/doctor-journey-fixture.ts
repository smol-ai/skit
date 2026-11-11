import { basename, join } from "node:path";
import { Clock, ConfigProvider, Effect, FileSystem, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Library from "@smolai/skit-core/library";
import {
  LinkStat,
  SourceProcess,
  SkitConfiguration,
  resolveSkitConfiguration,
} from "@smolai/skit-core/platform";
import { deterministicTreeHash } from "@smolai/skit-core/author";
import { makeMachineId } from "@smolai/skit-core/universal/consumer";
import collection from "../storybook/fixtures/doctor-collection.json" with { type: "json" };

export type DoctorSituation =
  | "healthy"
  | "drift"
  | "ownership"
  | "discovery-failed"
  | "no-history"
  | "with-history"
  | "no-candidates";

/** Seven large real listings can be removed; recent use protects the eighth managed Skill. */
export const doctorCleanupSkills = [
  "youtube-api",
  "youtube-channel-operator",
  "summarize-anything",
  "transcribe-anything",
  "new-mac-setup",
  "resilient-computer-use",
  "claude-session-introspect",
] as const;
export const doctorUsedSkill = "slackbot-builder";
const managedNames: readonly string[] = [...doctorCleanupSkills, doctorUsedSkill];

/** Verbatim pinned SKILL.md files; only native executable I/O is simulated. No budget override. */
export const makeDoctorJourneyFixture = Effect.fn("Storybook.makeDoctorJourneyFixture")(function* (
  root: string,
  situation: DoctorSituation,
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const home = join(root, ".skit");
  const cwd = join(root, "dev", "app");
  const skills = join(root, ".agents", "skills");
  const codexHome = join(root, ".codex");
  const options = { home: root, configHome: join(root, ".config"), overrides: {}, cwd };
  yield* fs.makeDirectory(cwd, { recursive: true });
  yield* fs.makeDirectory(codexHome, { recursive: true });
  const configuration = yield* resolveSkitConfiguration(home, root);
  const libraryLayer = Library.layer({ home, roots: options }).pipe(
    Layer.provideMerge(Layer.succeed(SkitConfiguration, configuration)),
    Layer.provideMerge(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          CODEX_HOME: codexHome,
          CLAUDE_CONFIG_DIR: join(root, ".claude"),
          OPENCODE_HOME: join(root, ".opencode"),
        }),
      ),
    ),
  );
  const healthy = ["healthy", "drift", "ownership"].includes(situation);
  const listed = healthy
    ? collection.skills.filter((skill) => managedNames.includes(skill.name))
    : collection.skills;
  yield* Effect.gen(function* () {
    const library = yield* Library.Service;
    for (const skill of collection.skills.filter((skill) => managedNames.includes(skill.name))) {
      const source = join(root, "source", skill.path);
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(join(source, "SKILL.md"), skill.document);
      if (skill.openaiMetadata) {
        yield* fs.makeDirectory(join(source, "agents"), { recursive: true });
        yield* fs.writeFileString(join(source, "agents", "openai.yaml"), skill.openaiMetadata);
      }
      const imported = yield* library.import.collection({
        machineId: makeMachineId(),
        source: { type: "local", path: source },
        input: source,
        importedAt: "2026-01-01T00:00:00.000Z",
        lockFileEntries: [],
        skills: [
          {
            name: skill.name,
            sourcePath: source,
            relativePath: ".",
            currentHash: yield* deterministicTreeHash(source),
          },
        ],
      });
      const plan = yield* library.plan(
        {
          _tag: "Enabled",
          changes: [
            {
              _tag: "Enable",
              subject: { _tag: "Skill", id: imported.skills[0]!.skill_id },
              where: [{ kind: "global" }],
            },
          ],
        },
        { base: yield* library.read },
      );
      if ((yield* library.apply({ _tag: "Apply", plan })).result._tag !== "Applied")
        return yield* Effect.die("Doctor fixture did not install its skills");
    }
  }).pipe(Effect.provide(libraryLayer));
  // The rest of the native listing exists on disk but is not owned by SKIT.
  for (const skill of listed) {
    if (managedNames.includes(skill.name) && situation !== "no-candidates") continue;
    const path = join(
      situation === "no-candidates" ? join(root, ".codex", "skills") : skills,
      skill.name,
    );
    yield* fs.makeDirectory(path, { recursive: true });
    yield* fs.writeFileString(join(path, "SKILL.md"), skill.document);
    if (skill.openaiMetadata) {
      yield* fs.makeDirectory(join(path, "agents"), { recursive: true });
      yield* fs.writeFileString(join(path, "agents", "openai.yaml"), skill.openaiMetadata);
    }
  }
  const first = doctorCleanupSkills[0];
  if (situation === "drift") {
    const path = join(skills, first, "SKILL.md");
    yield* fs.writeFileString(
      path,
      (yield* fs.readFileString(path)) + "\nLocally edited instructions.\n",
    );
  }
  if (situation === "ownership") yield* fs.remove(join(skills, first, ".skit-ownership.json"));
  if (situation === "with-history") {
    const sessions = join(codexHome, "sessions");
    yield* fs.makeDirectory(sessions, { recursive: true });
    const timestamp = new Date((yield* Clock.currentTimeMillis) - 60_000).toISOString();
    yield* fs.writeFileString(
      join(sessions, "activity.jsonl"),
      [
        { type: "session_meta", timestamp, payload: { id: "doctor-fixture", cwd } },
        { type: "turn_context", timestamp, payload: { cwd } },
        {
          type: "response_item",
          timestamp,
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "read-used-skill",
            arguments: JSON.stringify({ cmd: `cat ${join(skills, doctorUsedSkill, "SKILL.md")}` }),
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
  }
  const nativeSpawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (
        !ChildProcess.isStandardCommand(command) ||
        basename(command.command) !== "codex" ||
        command.args.join(" ") !== "app-server"
      )
        return yield* Effect.die(
          `Unexpected doctor fixture subprocess: ${JSON.stringify(command)}`,
        );
      const entries = [];
      for (const skill of listed) {
        const path = join(
          situation === "no-candidates" ? join(root, ".codex", "skills") : skills,
          skill.name,
          "SKILL.md",
        );
        if (yield* fs.exists(path))
          entries.push({
            name: skill.name,
            path,
            description: skill.description,
            interface: { displayName: skill.displayName },
            scope: "user",
            enabled: true,
          });
      }
      const responses =
        situation === "discovery-failed"
          ? [{ id: 2, error: { message: "Fixture Codex rejected skills/list" } }]
          : [
              { id: 1, result: {} },
              { id: 2, result: { data: [{ cwd, skills: entries, errors: [] }] } },
              // No model context or skills.max_context_tokens override: production resolves the bundled model default.
              { id: 3, result: { config: { model: "gpt-6.1-sol" } } },
            ];
      const stdout = Stream.succeed(
        new TextEncoder().encode(
          responses.map((response) => JSON.stringify(response)).join("\n") + "\n",
        ),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout,
        stderr: Stream.empty,
        all: stdout,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const nativeLayer = Layer.mergeAll(
    Layer.succeed(LinkStat, {
      ...links,
      identity: {
        ...links.identity,
        executable: (path) => Effect.succeed(basename(path) === "codex"),
      },
    }),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, nativeSpawner),
    Layer.succeed(SourceProcess, {
      output: (command, args) =>
        basename(command) === "codex" && args.join(" ") === "--version"
          ? Effect.succeed({
              stdout: new TextEncoder().encode("codex 0.160.1\n"),
              stderr: "",
              exitCode: 0,
            })
          : Effect.die(`Unexpected fixture process: ${command} ${args.join(" ")}`),
      run: (command) => Effect.die(`Unexpected fixture process: ${command}`),
    }),
  );
  return {
    options,
    names: managedNames,
    layer: libraryLayer.pipe(Layer.provideMerge(nativeLayer)),
    bytes: Effect.forEach(managedNames, (name) =>
      fs.readFileString(join(skills, name, "SKILL.md")).pipe(
        Effect.map((text) => [name, text] as const),
        Effect.orElseSucceed(() => [name, undefined] as const),
      ),
    ),
    unmanagedBytes: Effect.forEach(
      listed.filter((skill) => !managedNames.includes(skill.name) || situation === "no-candidates"),
      (skill) =>
        fs.readFileString(
          join(
            situation === "no-candidates" ? join(root, ".codex", "skills") : skills,
            skill.name,
            "SKILL.md",
          ),
        ),
    ),
  };
});
