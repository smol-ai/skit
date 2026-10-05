import { describe, expect, it } from "vitest";
import { JourneyPlayback } from "../src/playback";

const frames = [
  { label: "Ready", output: "" },
  { label: "Download", output: "Plan\n", status: "Downloading 0/2" },
  { label: "Result", output: "Done\n" },
];

describe("journey playback", () => {
  it("animates without advancing paused work and reconstructs earlier screens", () => {
    const playback = new JourneyPlayback(frames);
    playback.seek(1);
    playback.tick(1000);
    expect(playback.index).toBe(1);
    expect(playback.spinnerFrame).toBe(1);
    playback.seek(2);
    playback.seek(1);
    expect(playback.frame).toEqual(frames[1]);
  });

  it("advances on playback, stops at the end, and restarts on play", () => {
    const playback = new JourneyPlayback(frames);
    playback.toggle();
    playback.tick(1000);
    expect(playback.index).toBe(1);
    playback.tick(1000);
    expect(playback.index).toBe(2);
    expect(playback.playing).toBe(false);
    playback.toggle();
    expect(playback.index).toBe(0);
    expect(playback.playing).toBe(true);
    playback.seek(-10);
    expect(playback.index).toBe(0);
    expect(playback.playing).toBe(false);
    playback.seek(999);
    expect(playback.index).toBe(2);
  });
});
