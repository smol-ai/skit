import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { journeyStories } from "../src/storybook/journey-stories.js";
import { recordJourney } from "../src/storybook/journey-runner.js";
import { journeyFrames, renderReplayFrame } from "../src/storybook/journey-replay.js";
import { defaultTerminalEnvironment } from "../src/presentation/output-frame.js";

it.effect("replays a real fresh-device sync from a single captured run", () =>
  Effect.gen(function* () {
    const story = journeyStories.find((story) => story.name === "library-sync/fresh-device");
    expect(story).toBeDefined();
    if (!story) return;
    const recording = yield* recordJourney(story);
    const frames = journeyFrames(recording, defaultTerminalEnvironment);
    const download = frames.find((frame) => frame.status === "Downloading 3 Skill copies · 0/3");
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
  }),
);

it.effect("a failed-download preview clears status and shows the command failure", () =>
  Effect.gen(function* () {
    const story = journeyStories.find((story) => story.name === "library-sync/download-failed");
    if (!story) return;
    const frames = journeyFrames(yield* recordJourney(story), defaultTerminalEnvironment);
    expect(frames.some((frame) => frame.status?.startsWith("Downloading"))).toBe(true);
    expect(frames.at(-1)?.label).toBe("Failed");
    expect(frames.at(-1)?.status).toBeUndefined();
    expect(frames.at(-1)?.output).toContain("Error:");
    expect(frames.at(-1)?.output).not.toContain("Library synced.");
  }),
);

/* oxlint-disable skit/no-cli-output-text-assertions -- Replay stream routing is the behavior under test; progress has no JSON representation. */
it.effect.each(["human", "json"] as const)(
  "replays explicit sync progress on stderr with %s results on stdout",
  (format) =>
    Effect.gen(function* () {
      const story = journeyStories.find((story) => story.name === "library-sync/explicit-progress");
      expect(story).toBeDefined();
      if (!story) return;
      const recording = yield* recordJourney(story);
      const frames = journeyFrames(recording, { ...defaultTerminalEnvironment, format });
      const progress = frames.find(
        (frame) => frame.label === "Progress: Downloading 3 Skill copies · 0/3",
      );
      expect(progress).toBeDefined();
      expect(progress?.stdout).toBe("");
      expect(progress?.stderr).toContain("Downloading 3 Skill copies · 0/3\n");
      const final = frames.at(-1);
      expect(final?.stderr).toContain("Downloading 3 Skill copies · 3/3\n");
      expect(final?.stdout).not.toContain("Downloading");
      if (format === "json") {
        expect(JSON.parse(final?.stdout ?? "")).toMatchObject({
          schema: "skit.library.sync.v11",
          data: { status: "pulled" },
        });
        expect(frames.every((frame) => frame.status === undefined)).toBe(true);
        expect(final?.stderr).not.toContain("Library sync plan");
      } else {
        expect(final?.stdout).toContain("Library synced.");
        expect(final?.stderr).toContain("Library sync plan");
      }
    }),
);

/* oxlint-enable skit/no-cli-output-text-assertions */
