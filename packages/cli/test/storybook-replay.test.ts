import { it } from "@effect/vitest";
import { Effect } from "effect";
import { skitLayer } from "@smolai/skit-core/platform";
import { expect } from "vitest";
import { journeyStories } from "../src/storybook/journey-stories.js";
import { recordJourney } from "../src/storybook/journey-runner.js";
import { journeyFrames, renderReplayFrame } from "../src/storybook/journey-replay.js";
import { defaultTerminalEnvironment } from "../src/commands/output-frame.js";

it.effect("replays a real fresh-device sync from a single captured run", () =>
  Effect.gen(function* () {
    const story = journeyStories.find((story) => story.name === "library-sync/fresh-device");
    expect(story).toBeDefined();
    if (!story) return;
    const recording = yield* recordJourney(story);
    const frames = journeyFrames(recording, defaultTerminalEnvironment);
    const download = frames.find((frame) => frame.status === "Downloading 3 Skill copies | 0/3");
    expect(download).toBeDefined();
    if (!download) return;
    expect(download.output).toContain("Library sync plan");
    expect(download.output).not.toContain("Library synced.");
    expect(renderReplayFrame(download, 0)).not.toBe(renderReplayFrame(download, 1));
    const coloured = journeyFrames(recording, { ...defaultTerminalEnvironment, color: true });
    const colouredDownload = coloured.find((frame) => frame.status === download.status);
    expect(colouredDownload?.output).toContain("\u001b[36m");
    expect(download.output).not.toContain("\u001b[");
    expect(renderReplayFrame(download, 0)).not.toContain("\u001b[");
    const final = frames.at(-1);
    expect(final?.status).toBeUndefined();
    expect(final?.output).toContain("Library synced.");
    expect(coloured.at(-1)?.output).toContain("Library synced.");
    expect(coloured.at(-1)?.output).not.toContain("\u001b[32mLibrary synced.");
    expect(journeyFrames(recording, defaultTerminalEnvironment)).toEqual(frames);
    const json = journeyFrames(recording, { ...defaultTerminalEnvironment, format: "json" });
    expect(json).toHaveLength(2);
    expect(JSON.parse(json[1]!.output).data.status).toBe("pulled");
    expect(json.every((frame) => frame.status === undefined)).toBe(true);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("a failed-download preview clears status and shows the command failure", () =>
  Effect.gen(function* () {
    const story = journeyStories.find((story) => story.name === "library-sync/download-failed");
    if (!story) return;
    const frames = journeyFrames(yield* recordJourney(story), defaultTerminalEnvironment);
    expect(frames.some((frame) => frame.status?.startsWith("Downloading"))).toBe(true);
    expect(frames.at(-1)?.label).toBe("Failed");
    expect(frames.at(-1)?.status).toBeUndefined();
    expect(frames.at(-1)?.output).not.toContain("Library synced.");
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("a result screen names the contract state it reports", () =>
  Effect.gen(function* () {
    const story = journeyStories.find((story) => story.name === "library-sync/fresh-device");
    if (!story) return;
    const frames = journeyFrames(yield* recordJourney(story), defaultTerminalEnvironment);
    expect(frames.at(-1)?.outcome).toEqual({ contract: "librarySync", state: "pulled" });
    expect(frames.slice(0, -1).every((frame) => frame.outcome === undefined)).toBe(true);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("an answered prompt keeps the choices it offered beside the ones taken", () =>
  Effect.gen(function* () {
    const story = journeyStories.find((story) => story.name === "setup/guided-existing-skills");
    if (!story) return;
    const answers = journeyFrames(yield* recordJourney(story), defaultTerminalEnvironment).flatMap(
      (frame) => (frame.answer ? [frame.answer] : []),
    );
    expect(answers).toHaveLength(2);
    const [copies, confirm] = answers;
    expect(copies?.kind).toBe("multiselect");
    expect(copies?.chosen).toHaveLength(4);
    expect(copies?.offered.length).toBeGreaterThan(4);
    expect(copies?.chosen.every((label) => copies.offered.includes(label))).toBe(true);
    expect(confirm).toEqual({ kind: "confirm", offered: ["yes", "no"], chosen: ["yes"] });
  }).pipe(Effect.provide(skitLayer)),
);
