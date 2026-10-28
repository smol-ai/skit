import { skitConfigurationLayer } from "../configuration/skit-configuration.js";
import { presentDoctorCleanup } from "../workflows/library/doctor-cleanup.js";
import { syncJourney } from "./sync-journey.js";
import { join } from "node:path";
import { ConfigProvider, Effect, FileSystem, Option, Schema } from "effect";
import {
  LibraryState,
  LibraryStore,
  libraryAuditLogLayer,
  libraryStoreLayer,
  makeImportId,
  makeCollectionId,
  makeMachineId,
  makeInstalledSkillId,
  makeCollectionVersionId,
  makeSkillId,
  makeSkillVersionId,
  skitLayer,
  skillUsageLayer,
} from "@smolai/skit-core";
import { libraryCommandConfiguration } from "../commands/library-configuration.js";
import { presentSetEnabled } from "../handlers/library/set-enabled.js";
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

const digest = `sha256:${"0".repeat(64)}`;
const collectionId = makeCollectionId();
const collectionVersionId = makeCollectionVersionId();
const skillVersionId = makeSkillVersionId();
const skillId = makeSkillId();
const importId = makeImportId();
const machineId = makeMachineId();
const storyState = Schema.decodeUnknownSync(LibraryState)({
  schemaVersion: 10,
  collections: [
    {
      collection_id: collectionId,
      label: "review-tools",
    },
  ],
  skills: [
    {
      skill_id: skillId,
      collection_id: collectionId,
      path: ".",
      name: "review",
      versions: [
        {
          skill_version_id: skillVersionId,
          source_hash: digest,
          artifact_hash: digest,
          validation_identity_hash: digest,
          materialization_profile: "plain-skill/v1",
        },
      ],
    },
  ],
  collection_versions: [
    {
      collection_version_id: collectionVersionId,
      hash: digest,
      copy_profile: "verbatim/v1",
      members: [
        {
          source_path: ".",
          source_hash: digest,
          artifact_hash: digest,
          materialization_profile: "plain-skill/v1",
        },
      ],
    },
  ],
  imports: [
    {
      import_id: importId,
      collection_id: collectionId,
      kind: "source",
      collection_version_id: collectionVersionId,
      input: { value: "/fixtures/review" },
      source_identity: {
        kind: "local",
        machine_id: machineId,
        path: { value: "/fixtures/review" },
      },
      imported_at: "2026-01-01T00:00:00.000Z",
      machine_id: machineId,
      lock_file_entries: [],
    },
  ],
  enabled: [],
  repositories: [],
  installed_skills: [],
  unmanaged: [],
  adoption_receipts: [],
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
      const store = yield* LibraryStore;
      yield* store.save(storyState, yield* store.load);
      yield* presentSetEnabled({
        action: "enable",
        enabled: true,
        cwd: home,
        all: true,
        dryRun: true,
        interactive: true,
        configuration,
      });
      return yield* openLibrarySession();
    }).pipe(
      Effect.provide(libraryStoreLayer({ home })),
      Effect.provide(libraryAuditLogLayer({ home })),
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
      const store = yield* LibraryStore;
      yield* store.save(
        {
          ...storyState,
          enabled: [{ skill: skillId }],
          installed_skills: [
            {
              installed_skill_id: makeInstalledSkillId(),
              skill_id: skillId,
              skill_version_id: skillVersionId,
              destination: "agents",
              root: skillsRoot,
              path,
              expected_hash: digest,
              current_hash: digest,
              status: "installed",
              installed_at: "2026-10-18T00:00:00.000Z",
            },
          ],
        },
        yield* store.load,
      );
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
      return "Preview only · 1 Skill remains enabled";
    }).pipe(
      Effect.provide(libraryStoreLayer({ home })),
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
    answers: [[`${skillId}:global`]],
    run: previewDoctorCleanup.pipe(Effect.provide(skitConfigurationLayer())),
    finalState: (state) => state,
  },
  {
    name: "preview-enable-portable-collection",
    initialState: "1 Collection · 1 Skill · 0 Bindings",
    answers: [collectionId, "global"],
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
