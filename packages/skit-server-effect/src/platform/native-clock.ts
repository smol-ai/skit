import { Context, Layer } from "effect";

export interface NativeClockService {
  readonly now: () => Date;
}

export class NativeClock extends Context.Service<NativeClock, NativeClockService>()(
  "@skit-server-effect/NativeClock",
) {}

export const layer = Layer.succeed(NativeClock, NativeClock.of({ now: () => new Date() }));
