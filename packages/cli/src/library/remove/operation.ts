import { Effect } from "effect";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { removeAuthorCollection } from "@smolai/skit-core/author";
export interface RemoveOptions {
  readonly query: string;
  readonly dryRun: boolean;
}
export const executeRemove = Effect.fn("CLI.executeRemove")(function* (options: RemoveOptions) {
  return yield* removeAuthorCollection((yield* SkitConfiguration).skitHome, options);
});
