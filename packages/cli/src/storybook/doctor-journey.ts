import { Effect } from "effect";
import * as Library from "@smolai/skit-core/library";
import { skitLayer } from "@smolai/skit-core/platform";
import {
  makeDoctorJourneyFixture,
  doctorCleanupSkills,
  doctorUsedSkill,
  type DoctorSituation,
} from "../platform/doctor-journey-fixture.js";
import { runDoctor } from "../library/doctor/run.js";
import type { JourneyStory } from "./journey-stories.js";
import type { ScriptedAnswer, TypeCommand } from "./interaction-recorder.js";

interface DoctorScenario {
  readonly name: string;
  readonly description: string;
  readonly initialState: string;
  readonly situation: DoctorSituation;
  readonly answers: readonly ScriptedAnswer[];
  readonly mode?: "preview" | "report-only" | "noninteractive";
  readonly disables?: boolean;
}

const scenarios: readonly DoctorScenario[] = [
  {
    name: "healthy",
    description:
      "Scan installed Skills and native discovery, then explain a healthy listing within budget.",
    initialState: "8 managed Skills | native Codex discovers all 8 | listing within budget",
    situation: "healthy",
    answers: [],
  },
  {
    name: "edited-installed-skill",
    description:
      "Diagnose locally edited installed instructions without replacing the person's changes.",
    initialState: "8 managed Skills | youtube-api/SKILL.md edited after installation",
    situation: "drift",
    answers: [],
  },
  {
    name: "missing-ownership-marker",
    description:
      "Show what doctor reports when an installed Skill has lost its ownership marker, without claiming it again.",
    initialState: "8 installed Skills | youtube-api's ownership marker removed",
    situation: "ownership",
    answers: [],
  },
  {
    name: "discovery-failed",
    description:
      "Keep the filesystem diagnosis when native discovery rejects skills/list, and explain the unavailable budget.",
    initialState: "8 managed Skills | Codex responds to --version but rejects skills/list",
    situation: "discovery-failed",
    answers: [],
  },
  {
    name: "cleanup-preview",
    description:
      "Read the complete diagnostic report, explicitly select a Skill without usage history, and preview cleanup without changing enabled Skills.",
    initialState:
      "99 real swyxio/skills listings | 8 managed, 91 unmanaged | 10,000-token default budget | no transcript history",
    situation: "no-history",
    mode: "preview",
    answers: [{ labels: [doctorCleanupSkills[0]] }],
  },
  {
    name: "over-budget-cleanup",
    description:
      "Start with an over-budget diagnostic report, protect a recently used Skill, confirm cleanup, and recheck that the listing is within budget.",
    initialState:
      "99 real swyxio/skills listings | 8 managed, 91 unmanaged | 10,000-token default budget | slackbot-builder recently used",
    situation: "with-history",
    answers: [{ labels: doctorCleanupSkills }, true],
    disables: true,
  },
  {
    name: "cleanup-declined",
    description:
      "Review the cleanup plan and decline confirmation, keeping all enabled Skills and installed files.",
    initialState:
      "99 real swyxio/skills listings | 8 managed, 91 unmanaged | 10,000-token default budget | slackbot-builder recently used",
    situation: "with-history",
    answers: [{ labels: doctorCleanupSkills }, false],
  },
  {
    name: "cleanup-cancelled",
    description: "Cancel the cleanup selection after reading the diagnosis; no plan is applied.",
    initialState:
      "99 real swyxio/skills listings | 8 managed, 91 unmanaged | 10,000-token default budget | slackbot-builder recently used",
    situation: "with-history",
    answers: ["escape"],
  },
  {
    name: "cleanup-nothing-selected",
    description:
      "Leave every cleanup suggestion unselected and finish without a confirmation or filesystem changes.",
    initialState:
      "99 real swyxio/skills listings | 8 managed, 91 unmanaged | 10,000-token default budget | slackbot-builder recently used",
    situation: "with-history",
    answers: [[]],
  },
  {
    name: "cleanup-no-safe-candidates",
    description:
      "Explain why an over-budget native listing cannot be safely reduced when its Skills are unmanaged.",
    initialState:
      "99 real swyxio/skills listings in a separate unmanaged root | 10,000-token default budget | no safe managed candidates",
    situation: "no-candidates",
    answers: [],
  },
  {
    name: "report-only",
    description:
      "Use --report-only to inspect an over-budget listing without entering interactive cleanup.",
    initialState:
      "99 real swyxio/skills listings | 8 managed, 91 unmanaged | 10,000-token default budget | usage history available",
    situation: "with-history",
    mode: "report-only",
    answers: [],
  },
  {
    name: "noninteractive",
    description:
      "Show diagnostics in an unattended terminal without asking cleanup questions or disabling Skills.",
    initialState:
      "99 real swyxio/skills listings | 8 managed, 91 unmanaged | 10,000-token default budget | prompts unavailable",
    situation: "with-history",
    mode: "noninteractive",
    answers: [],
  },
];

const runScenario = (scenario: DoctorScenario, root: string, typed: TypeCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeDoctorJourneyFixture(root, scenario.situation);
      return yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const before = yield* library.read;
        if (before._tag !== "Present") return yield* Effect.die("Expected doctor fixture Library");
        const bytes = yield* fixture.bytes;
        const unmanaged = yield* fixture.unmanagedBytes;
        const flags =
          scenario.mode === "preview"
            ? " --dry-run"
            : scenario.mode === "report-only"
              ? " --report-only"
              : "";
        yield* typed(`skit doctor${flags}`);
        yield* runDoctor({
          options: fixture.options,
          days: 14,
          dryRun: scenario.mode === "preview",
          interactive: scenario.mode !== "report-only" && scenario.mode !== "noninteractive",
        });
        const after = yield* library.read;
        if (after._tag !== "Present") return yield* Effect.die("Doctor lost the Library");
        const remaining = yield* fixture.bytes;
        if (JSON.stringify(yield* fixture.unmanagedBytes) !== JSON.stringify(unmanaged))
          return yield* Effect.die("Doctor changed unmanaged Skill files");
        if (scenario.disables) {
          if (
            remaining
              .filter(([, bytes]) => bytes !== undefined)
              .map(([name]) => name)
              .join() !== doctorUsedSkill ||
            after.state.enabled.length !== 1 ||
            remaining.find(([name]) => name === doctorUsedSkill)?.[1] !==
              bytes.find(([name]) => name === doctorUsedSkill)?.[1]
          )
            return yield* Effect.die(
              "Doctor cleanup did not preserve exactly the recently used Skill",
            );
          return "7 unused managed Skills disabled globally | slackbot-builder remains enabled and installed | 91 unmanaged Skills unchanged | doctor rechecked native discovery";
        }
        if (
          JSON.stringify(after.state.enabled) !== JSON.stringify(before.state.enabled) ||
          JSON.stringify(remaining) !== JSON.stringify(bytes)
        )
          return yield* Effect.die(
            "Doctor changed enabled Skills or installed instructions without applying cleanup",
          );
        return "8 managed Skills remain enabled | installed instructions unchanged";
      }).pipe(Effect.provide(fixture.layer));
    }),
  ).pipe(Effect.provide(skitLayer));

/** Every scenario uses the complete production workflow; executable responses are fixture data. */
export const doctorJourneys: readonly JourneyStory<
  string,
  Effect.Error<ReturnType<typeof runScenario>>,
  Effect.Services<ReturnType<typeof runScenario>>
>[] = scenarios.map((scenario) => ({
  _tag: "Journey",
  name: `doctor/${scenario.name}`,
  description: scenario.description,
  initialState: scenario.initialState,
  evidence:
    "Complete doctor workflow using verbatim SKILL.md files and metadata from swyxio/skills at 038ef3441a4c7bfff16ae3241dc1730746a69a5b. Eight Skills are managed; other listed Skills are unmanaged. SKIT resolves gpt-6.1-sol’s 500,000-token bundled context default × its 2% listing policy = 10,000 tokens, without a budget override. Listings are estimates, not measured model token usage. Native subprocess responses and terminal answers are fixtures; CLI parsing and live harness compatibility are not demonstrated.",
  answers: scenario.answers,
  run: (home, typed) => runScenario(scenario, home, typed),
  finalState: (state) => state,
}));

/** Reviewed doctor paths; absent flow links are explicit gaps, not completion claims. */
export const doctorScenarioInventory = [
  ...scenarios.map((scenario) => ({
    name: scenario.name,
    description: scenario.description,
    flow: `doctor/${scenario.name}`,
  })),
  {
    name: "custom-roots",
    description: "Custom skills directories skip native discovery for the overridden harness.",
  },
  {
    name: "unknown-budget",
    description: "Discovery succeeds but configuration or a usable budget limit is unavailable.",
  },
  {
    name: "multiple-harnesses",
    description: "Several harnesses disagree about discovery, collisions or listing costs.",
  },
  {
    name: "scope-specific-cleanup",
    description: "Disable a global Skill while keeping its enabled repository copy.",
  },
  {
    name: "followed-collection",
    description:
      "Disable some members and explain that the scope stops following future Collection additions.",
  },
  {
    name: "stale-plan",
    description:
      "Library state changes between review and apply; the reviewed plan must not silently change.",
  },
  {
    name: "apply-conflict",
    description: "An installed folder cannot safely be changed while applying cleanup.",
  },
  {
    name: "incomplete-usage",
    description:
      "Unreadable or unsupported transcripts limit the evidence available for cleanup suggestions.",
  },
];
