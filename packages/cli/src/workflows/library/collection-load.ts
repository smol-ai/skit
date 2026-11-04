import { Effect } from "effect";
import { readDescriptionLoad } from "@smolai/skit-core/library/session";
export { readDescriptionLoad } from "@smolai/skit-core/library/session";

export const largeCollectionWarning = (count: number): string | undefined =>
  count > 100
    ? `Large skill listing (${count} skills). Run skit doctor to check description visibility.`
    : undefined;

export function descriptionLoadMessage(
  load: Effect.Success<ReturnType<typeof readDescriptionLoad>>,
): string {
  return `${load.skills} skills · ${load.characters.toLocaleString("en-US")} description characters${load.unknown ? ` · ${load.unknown} unmeasured` : ""}`;
}
