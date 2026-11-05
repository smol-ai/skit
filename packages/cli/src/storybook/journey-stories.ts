import { Library } from "@smolai/skit-core/library";
import { skitConfigurationLayer } from "@smolai/skit-core";
import { presentDoctorCleanup } from "../workflows/library/doctor-cleanup.js";
import { syncJourney } from "./sync-journey.js";
import { join } from "node:path";
import { ConfigProvider, Effect, FileSystem, Option } from "effect";
import {
  deterministicTreeHash,
  makeMachineId,
  skitLayer,
  skillUsageLayer,
} from "@smolai/skit-core";
import { libraryCommandConfiguration } from "../commands/library-configuration.js";
import { presentSetEnabled } from "../library/enable/command.js";
import type { Prompter } from "../presentation/prompter.js";
import type { Renderer } from "../presentation/renderer.js";
import type { ScriptedAnswer } from "../presentation/interaction-recorder.js";
import { openLibrarySession } from "../library-application/session.js";

export interface JourneyStory<A, E, R> {
  readonly name: string;
  readonly expectedOutcome?: "success" | "failure";
  readonly initialState: string;
  readonly answers: ReadonlyArray<ScriptedAnswer>;
  readonly run: Effect.Effect<A, E, R>;
  readonly finalState: (result: A) => string;
}

/** Real retained bytes and owner-generated identities, shared by the preview journeys. */
const importReview = Effect.fn("Storybook.importReview")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const library = yield* Library.Service;
  const sourcePath = join(root, "review-tools");
  yield* fs.makeDirectory(sourcePath, { recursive: true });
  yield* fs.writeFileString(
    join(sourcePath, "SKILL.md"),
    "---\nname: review\ndescription: Review code changes.\n---\n# Review\nPreserve the intended behavior.\n",
  );
  return yield* library.import.collection({
    machineId: makeMachineId(),
    source: { type: "local", path: sourcePath },
    input: sourcePath,
    importedAt: "2026-01-01T00:00:00.000Z",
    skills: [
      {
        name: "review",
        sourcePath,
        relativePath: ".",
        currentHash: yield* deterministicTreeHash(sourcePath),
      },
    ],
    lockFileEntries: [],
  });
});

const previewEnable = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-story-library-" });
    const codexRoot = `${home}/codex`;
    yield* fs.makeDirectory(codexRoot);
    const configuration = yield* libraryCommandConfiguration({
      home: Option.some(home),
      codexRoot: Option.some(codexRoot),
      claudeRoot: Option.none(),
      opencodeRoot: Option.none(),
      devinRoot: [],
    });
    return yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      yield* importReview(home);
      const before = yield* library.read;
      yield* presentSetEnabled({
        action: "enable",
        enabled: true,
        cwd: home,
        all: true,
        dryRun: true,
        interactive: true,
        configuration,
      });
      const after = yield* library.read;
      if (
        before._tag !== "Present" ||
        after._tag !== "Present" ||
        before.revision !== after.revision ||
        (yield* fs.readDirectory(codexRoot)).length !== 0
      )
        return yield* Effect.die("The enable preview changed the Library or installed files");
      return yield* openLibrarySession(configuration.pull.installOptions);
    }).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
      Effect.provide(skitConfigurationLayer(home)),
    );
  }),
).pipe(Effect.provide(skitLayer), Effect.provide(skitConfigurationLayer()));

const previewDoctorCleanup = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-doctor-story-" });
    const home = join(root, "library");
    const account = join(root, "account");
    const skillsRoot = join(account, ".agents", "skills");
    const path = join(skillsRoot, "review");
    const configuration = {
      home: account,
      configHome: account,
      overrides: { codex: [skillsRoot] },
    };
    return yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const imported = yield* importReview(root);
      const skill = imported.skills[0];
      if (!skill) return yield* Effect.die("Expected the imported review Skill");
      const plan = yield* library.plan(
        {
          _tag: "Enabled",
          changes: [
            {
              _tag: "Enable",
              subject: { _tag: "Skill", id: skill.skill_id },
              where: [{ kind: "global" }],
            },
          ],
        },
        { base: yield* library.read },
      );
      const installed = (yield* library.apply({ _tag: "Apply", plan: plan })).result;
      if (installed._tag !== "Applied" || !(yield* fs.exists(join(path, "SKILL.md"))))
        return yield* Effect.die("Expected the review Skill to be installed");
      const before = yield* library.read;
      const bytes = yield* fs.readFileString(join(path, "SKILL.md"));
      yield* presentDoctorCleanup(
        [
          {
            _tag: "Estimated",
            harness: "codex",
            cwd: root,
            model: "fixture",
            unit: "budget-tokens",
            demand: 12000,
            limit: 10000,
            fitted: 10000,
            shortened: 0,
            omitted: 0,
            descriptionsDropped: { min: 0, max: 0 },
            fidelity: "modelled",
            collections: [],
            basis: "Synthetic spike fixture",
            coverage: [],
            entries: [{ name: "review", path: join(path, "SKILL.md"), demand: 2500 }],
          },
        ],
        configuration,
        30,
        true,
      );
      const after = yield* library.read;
      if (
        before._tag !== "Present" ||
        after._tag !== "Present" ||
        before.revision !== after.revision ||
        (yield* fs.readFileString(join(path, "SKILL.md"))) !== bytes
      )
        return yield* Effect.die("The cleanup preview changed the Library or installed bytes");
      return `Preview only · ${after.state.enabled.length} Skill remains enabled`;
    }).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "Configured", ...configuration } })),
      Effect.provide(skitConfigurationLayer(home)),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            CODEX_HOME: join(root, "codex"),
            CLAUDE_CONFIG_DIR: join(root, "claude"),
          }),
        ),
      ),
    );
  }),
).pipe(Effect.provide(skillUsageLayer), Effect.provide(skitLayer));

export const journeyStories: ReadonlyArray<JourneyStory<string, unknown, Prompter | Renderer>> = [
  {
    name: "doctor/cleanup-preview",
    initialState: "Codex listing ~12,000 / 10,000 tokens · no retained usage transcripts",
    answers: [{ labels: ["review"] }],
    run: previewDoctorCleanup.pipe(Effect.provide(skitConfigurationLayer())),
    finalState: (state) => state,
  },
  {
    name: "preview-enable-portable-collection",
    initialState: "1 Collection · 1 Skill · 0 Bindings",
    answers: [{ label: "review-tools" }, "global"],
    run: previewEnable.pipe(
      Effect.map(
        (state) =>
          `${state.skills.length} Skill · ${state.skills.flatMap((skill) => skill.scopes).length} Bindings`,
      ),
    ),
    finalState: (state) => state,
  },
  {
    name: "library-sync/fresh-device",
    initialState: "Empty fixture device · remote has 3 Collections and 3 enabled Skills",
    answers: [],
    run: syncJourney(false).pipe(Effect.provide(skitConfigurationLayer())),
    finalState: (state) => state,
  },
  {
    name: "library-sync/download-failed",
    expectedOutcome: "failure",
    initialState: "Empty fixture device · Registry rejects the second download",
    answers: [],
    run: syncJourney(true).pipe(Effect.provide(skitConfigurationLayer())),
    finalState: (state) => state,
  },
];
