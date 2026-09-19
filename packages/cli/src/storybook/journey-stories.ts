import { Effect, FileSystem, Option, Schema } from "effect";
import {
  LibraryState,
  LibraryStore,
  libraryAuditLogLayer,
  libraryStoreLayer,
  makeAcquisitionId,
  makeCollectionId,
  makeMachineId,
  makeRetainedCopyId,
  makeSkillId,
  makeSkillVersionId,
  skitLayer,
} from "@smolai/skit-core";
import { libraryCommandConfiguration } from "../commands/library-configuration.js";
import { presentPortableSetEnabled } from "../handlers/library/set-enabled.js";
import type { Prompter } from "../presentation/prompter.js";
import type { Renderer } from "../presentation/renderer.js";
import type { ScriptedAnswer } from "../presentation/interaction-recorder.js";
import { openLibrarySession, type LibrarySessionState } from "../workflows/library/session.js";

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
  schemaVersion: 5,
  collections: [
    {
      collection_id: collectionId,
      display_name: "review-tools",
    },
  ],
  skills: [
    {
      skill_id: skillId,
      collection_id: collectionId,
      path: ".",
      name: "review",
      selected_skill_version_id: skillVersionId,
      versions: [
        {
          skill_version_id: skillVersionId,
          source_digest: digest,
          artifact_digest: digest,
          validation_identity_digest: digest,
          materialization_profile: "plain-skill/v1",
          origins: [{ acquisition_id: acquisitionId, source_path: "." }],
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
      retained_copy_id: retainedTreeId,
      input: { value: "/fixtures/review" },
      source_identity: {
        kind: "local",
        machine_id: machineId,
        path: { value: "/fixtures/review" },
      },
      tracking: { kind: "default" },
      selection: { kind: "full-tree" },
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
      yield* store.publish(storyState);
      yield* presentPortableSetEnabled({
        action: "enable",
        enabled: true,
        requested: "codex",
        cwd: home,
        all: true,
        dryRun: true,
        interactive: true,
        configuration,
      });
      return yield* openLibrarySession(["codex"]);
    }).pipe(
      Effect.provide(libraryStoreLayer({ home })),
      Effect.provide(libraryAuditLogLayer({ home })),
    );
  }),
).pipe(Effect.provide(skitLayer));

export const journeyStories: ReadonlyArray<
  JourneyStory<LibrarySessionState, unknown, Prompter | Renderer>
> = [
  {
    name: "preview-enable-portable-collection",
    initialState: "1 Collection · 1 Skill · 0 Bindings",
    answers: [collectionId, "global"],
    run: previewEnable,
    finalState: (state: LibrarySessionState) =>
      `${state.skills.length} Skill · ${state.skills.flatMap((skill) => skill.bindings).length} Bindings`,
  },
];
