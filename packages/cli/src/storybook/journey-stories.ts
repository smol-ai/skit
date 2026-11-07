import {
  importReview,
  makeEnablePreviewFixture,
  makeDoctorPreviewFixture,
} from "../platform/storybook-fixtures.js";
import { SkitConfiguration, skitConfigurationLayer, skitLayer } from "@smolai/skit-core/platform";
import * as Library from "@smolai/skit-core/library";

import { presentDoctorCleanup } from "../library/doctor/cleanup.js";
import { syncJourney } from "./sync-journey.js";
import { join } from "node:path";
import { ConfigProvider, Effect } from "effect";

import { inventoryRootOptions } from "@smolai/skit-core/library/routing";
import { presentSetEnabled } from "../library/enable.js";
import type { Prompter } from "../terminal/prompter.js";
import type { Renderer } from "../terminal/renderer.js";
import type { ScriptedAnswer } from "./interaction-recorder.js";

export interface JourneyStory<A, E, R> {
  readonly name: string;
  readonly expectedOutcome?: "success" | "failure";
  readonly initialState: string;
  readonly answers: ReadonlyArray<ScriptedAnswer>;
  readonly run: Effect.Effect<A, E, R>;
  readonly finalState: (result: A) => string;
}

const previewEnable = Effect.scoped(
  Effect.gen(function* () {
    const { home, codexRoot, installedEmpty } = yield* makeEnablePreviewFixture;
    const configuration = {
      inventory: inventoryRootOptions(yield* SkitConfiguration, { codex: [codexRoot] }),
    };
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
      });
      const after = yield* library.read;
      if (
        before._tag !== "Present" ||
        after._tag !== "Present" ||
        before.revision !== after.revision ||
        !(yield* installedEmpty)
      )
        return yield* Effect.die("The enable preview changed the Library or installed files");
      return yield* library.session.open();
    }).pipe(
      Effect.provide(Library.layer({ home, roots: configuration.inventory })),
      Effect.provide(skitConfigurationLayer(home)),
    );
  }),
).pipe(Effect.provide(skitLayer), Effect.provide(skitConfigurationLayer()));

const previewDoctorCleanup = Effect.scoped(
  Effect.gen(function* () {
    const {
      root,
      home,
      account,
      skillsRoot,
      path,
      installed: documentExists,
      document,
    } = yield* makeDoctorPreviewFixture;
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
      if (installed._tag !== "Applied" || !(yield* documentExists))
        return yield* Effect.die("Expected the review Skill to be installed");
      const before = yield* library.read;
      const bytes = yield* document;
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
        (yield* document) !== bytes
      )
        return yield* Effect.die("The cleanup preview changed the Library or installed bytes");
      return `Preview only · ${after.state.enabled.length} Skill remains enabled`;
    }).pipe(
      Effect.provide(Library.layer({ home, roots: configuration })),
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
).pipe(Effect.provide(skitLayer));

export const journeyStories: ReadonlyArray<
  JourneyStory<
    string,
    Effect.Error<
      typeof previewDoctorCleanup | typeof previewEnable | ReturnType<typeof syncJourney>
    >,
    Prompter | Renderer
  >
> = [
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
    run: syncJourney(false),
    finalState: (state) => state,
  },
  {
    name: "library-sync/download-failed",
    expectedOutcome: "failure",
    initialState: "Empty fixture device · Registry rejects the second download",
    answers: [],
    run: syncJourney(true),
    finalState: (state) => state,
  },
];
