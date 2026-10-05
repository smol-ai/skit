import type { ReplayFrame } from "../../cli/src/front-end";

/** Wall time animates the current screen; only explicit steps or playback move the cursor. */
export class JourneyPlayback {
  index = 0;
  playing = false;
  spinnerFrame = 0;
  private elapsed = 0;

  constructor(readonly frames: ReadonlyArray<ReplayFrame>) {}

  get frame(): ReplayFrame | undefined {
    return this.frames[this.index];
  }

  seek(index: number): void {
    this.index = Math.max(0, Math.min(index, this.frames.length - 1));
    this.playing = false;
    this.elapsed = 0;
  }

  toggle(): void {
    if (this.index === this.frames.length - 1) this.index = 0;
    this.playing = !this.playing;
    this.elapsed = 0;
  }

  tick(milliseconds: number): void {
    this.spinnerFrame++;
    if (!this.playing) return;
    this.elapsed += milliseconds;
    if (this.elapsed < 1000) return;
    this.elapsed %= 1000;
    this.index = Math.min(this.index + 1, this.frames.length - 1);
    if (this.index === this.frames.length - 1) this.playing = false;
  }
}
