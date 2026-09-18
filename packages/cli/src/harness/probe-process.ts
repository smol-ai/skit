// Capturing a probe's output without trusting how much of it there is.
//
// `spawnSync` bounded these with maxBuffer; the spawner's own `string()` collector does not bound
// anything, so this counts bytes as the pipe is drained and fails the moment the budget is passed.
// The Scope owns the child, so failing here kills it rather than letting it keep writing.

import { Effect } from "effect";
import { SourceProcess } from "@smolai/skit-core";

export interface BoundedCapture {
  readonly output: string;
  readonly exitCode: number;
}

/**
 * Run a probe, returning its output and exit status.
 *
 * `limit` is the byte budget the previous `maxBuffer` expressed, `timeoutMs` the previous timeout.
 * Both are enforced while the process runs rather than after it finishes.
 */
export const captureBounded = Effect.fn("Probe.capture")(function* (
  command: string,
  args: readonly string[],
  options: { limit: number; timeoutMs: number; includeStderr?: boolean },
) {
  const process = yield* SourceProcess;
  const result = yield* process.output(command, args, {
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.limit,
    maxErrorBytes: options.limit,
  });
  const output = new TextDecoder().decode(result.stdout);
  return {
    output: options.includeStderr === true ? `${output}\n${result.stderr}` : output,
    exitCode: result.exitCode,
  };
});
