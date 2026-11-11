import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Schema } from "effect";
import { skitLayer } from "@smolai/skit-core/platform";
import { DoctorReport } from "@smolai/skit-core/library/inventory";
import { doctorCleanupSkills } from "../src/platform/doctor-journey-fixture.js";
import { doctorJourneys } from "../src/storybook/doctor-journey.js";
import { recordJourney } from "../src/storybook/journey-runner.js";
import { journeyFrames } from "../src/storybook/journey-replay.js";
import { defaultTerminalEnvironment } from "../src/terminal/contracts.js";

for (const story of doctorJourneys) {
  it.effect(
    `records ${story.name} through diagnosis, its decision path and verified final state`,
    () =>
      Effect.gen(function* () {
        const recording = yield* recordJourney(story);
        expect(recording._tag).toBe("Journey");
        if (recording._tag !== "Journey") return yield* Effect.die("Expected a journey recording");
        expect(recording.finalState).not.toMatch(/^failed:/);
        const events = recording.events;
        const reports = events.filter(
          (event) => event._tag === "Result" && event.result.contract === "doctor",
        );
        const prompts = events.filter((event) => event._tag === "PromptShown");
        expect(events[0]).toMatchObject({
          _tag: "Command",
          line: expect.stringContaining("skit doctor"),
        });
        expect(
          events.some(
            (event) =>
              event._tag === "StatusStarted" && event.message === "Scanning harness installations",
          ),
        ).toBe(true);
        expect(
          events.some(
            (event) =>
              event._tag === "StatusStarted" &&
              event.message === "Checking native harness skill discovery",
          ),
        ).toBe(true);
        const firstReport = events.findIndex(
          (event) => event._tag === "Result" && event.result.contract === "doctor",
        );
        const firstPrompt = events.findIndex((event) => event._tag === "PromptShown");
        if (firstPrompt !== -1) expect(firstReport).toBeLessThan(firstPrompt);
        const output = journeyFrames(recording, defaultTerminalEnvironment).at(-1)?.output ?? "";
        expect(output).toContain("SKIT doctor");
        if (story.name === "doctor/over-budget-cleanup") {
          expect(reports).toHaveLength(2);
          expect(prompts).toHaveLength(2);
          expect(recording.finalState).toContain("slackbot-builder remains enabled and installed");
          const reportData = reports.map((event) =>
            event._tag === "Result"
              ? Schema.decodeUnknownSync(DoctorReport)(event.result.data)
              : undefined,
          );
          const budgets = reportData.map((report) =>
            report?.listing_budgets.find((budget) => budget.harness === "codex"),
          );
          for (const budget of budgets) {
            expect(budget?._tag).toBe("Estimated");
            if (budget?._tag !== "Estimated") throw new Error("Expected Codex budget");
            expect(budget.limit).toBe(10000);
            expect(budget.provenance).toMatchObject({
              _tag: "CodexAllocation",
              contextWindow: 500000,
              fraction: 0.02,
            });
            expect(budget.provenance).not.toHaveProperty("maxContextTokens");
          }
          const [beforeBudget, afterBudget] = budgets;
          if (beforeBudget?._tag !== "Estimated" || afterBudget?._tag !== "Estimated")
            throw new Error("Expected both Codex estimates");
          expect(beforeBudget.demand).toBeGreaterThan(10000);
          expect(afterBudget.demand).toBeLessThanOrEqual(10000);
          expect(reportData[0]?.codex.instances).toHaveLength(99);
          if (budgets[0]?._tag === "Estimated")
            expect(
              budgets[0].entries.some((entry) => ["coordinate", "generalize"].includes(entry.name)),
            ).toBe(false);
          expect(reportData[1]?.codex.instances).toHaveLength(92);
          expect(
            events.some((event) => event._tag === "Result" && event.result.contract === "disable"),
          ).toBe(true);
          const choices = prompts[0]?._tag === "PromptShown" ? prompts[0].choices : [];
          expect(choices.map((choice) => choice.label).sort()).toEqual(
            [...doctorCleanupSkills].sort(),
          );
          expect(choices.some((choice) => choice.selected)).toBe(true);
        } else {
          expect(reports).toHaveLength(1);
          expect(
            events.some((event) => event._tag === "Result" && event.result.contract === "disable"),
          ).toBe(false);
          expect(recording.finalState).toContain("instructions unchanged");
        }
        if (story.name === "doctor/cleanup-preview") {
          expect(prompts).toHaveLength(1);
          expect(prompts[0]?._tag === "PromptShown" && prompts[0].message).toContain(
            "last 14 days",
          );
          expect(
            prompts[0]?._tag === "PromptShown" &&
              prompts[0].choices.every((choice) => !choice.selected),
          ).toBe(true);
          expect(output).toContain("No transcript history");
        }
        if (
          [
            "doctor/healthy",
            "doctor/discovery-failed",
            "doctor/cleanup-no-safe-candidates",
            "doctor/report-only",
            "doctor/noninteractive",
          ].includes(story.name)
        )
          expect(prompts).toHaveLength(0);
        if (story.name === "doctor/discovery-failed")
          expect(output).toContain("Fixture Codex rejected skills/list");
        if (story.name === "doctor/edited-installed-skill")
          expect(output).toMatch(/installed files differ/);
        if (story.name === "doctor/missing-ownership-marker")
          expect(output).toMatch(/ownership|marker/i);
        if (story.name === "doctor/cleanup-no-safe-candidates")
          expect(output).toContain("No unused managed skills");
        if (story.name === "doctor/cleanup-declined") expect(prompts).toHaveLength(2);
        if (
          story.name === "doctor/cleanup-nothing-selected" ||
          story.name === "doctor/cleanup-cancelled"
        )
          expect(prompts).toHaveLength(1);
      }).pipe(Effect.provide(skitLayer)),
  );
}
