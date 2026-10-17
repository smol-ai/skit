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
  makeAcquisitionId,
  makeCollectionId,
  makeMachineId,
  makeProjectionId,
  makeRetainedCopyId,
  makeSkillId,
  makeSkillVersionId,
  skitLayer,
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
const retainedTreeId = makeRetainedCopyId();
const skillVersionId = makeSkillVersionId();
const skillId = makeSkillId();
const acquisitionId = makeAcquisitionId();
const machineId = makeMachineId();
const storyState = Schema.decodeUnknownSync(LibraryState)({
  schemaVersion: 8,
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
          source_digest: digest,
          artifact_digest: digest,
          validation_identity_digest: digest,
          materialization_profile: "plain-skill/v1",
        },
      ],
    },
  ],
  retained_copies: [
    {
      retained_copy_id: retainedTreeId,
      digest,
      copy_profile: "verbatim/v1",
      members: [
        {
          source_path: ".",
          source_digest: digest,
          artifact_digest: digest,
          materialization_profile: "plain-skill/v1",
        },
      ],
    },
  ],
  acquisitions: [
    {
      acquisition_id: acquisitionId,
      collection_id: collectionId,
      kind: "source",
      retained_copy_id: retainedTreeId,
      input: { value: "/fixtures/review" },
      source_identity: {
        kind: "local",
        machine_id: machineId,
        path: { value: "/fixtures/review" },
      },
      acquired_at: "2026-01-01T00:00:00.000Z",
      machine_id: machineId,
      observations: [],
    },
  ],
  global_bindings: [],
  local_bindings: [],
  projections: [],
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
      yield* store.publish(storyState, yield* store.load);
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
      yield* store.publish(
        {
          ...storyState,
          global_bindings: [
            { scope: { kind: "global" }, entries: [{ kind: "skill", skill_id: skillId }] },
          ],
          projections: [
            {
              projection_id: makeProjectionId(),
              skill_id: skillId,
              skill_version_id: skillVersionId,
              target: "agents",
              root: skillsRoot,
              path,
              expected_digest: digest,
              observed_digest: digest,
              status: "installed",
              projected_at: "2026-10-18T00:00:00.000Z",
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
).pipe(Effect.provide(skitLayer));

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
          `${state.skills.length} Skill · ${state.skills.flatMap((skill) => skill.bindings).length} Bindings`,
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
