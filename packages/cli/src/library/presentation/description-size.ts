import type { Effect } from "effect";
import type { readLibraryDescriptionLoad } from "@smolai/skit-core/library/session";

export const largeCollectionWarning = (count: number): string | undefined =>
  count > 100
    ? `Large skill listing (${count} skills). Run skit doctor to check description visibility.`
    : undefined;

export function descriptionLoadMessage(
  load: Effect.Success<ReturnType<typeof readLibraryDescriptionLoad>>,
): string {
  return `${load.skills} skills · ${load.characters.toLocaleString("en-US")} description characters${load.unknown ? ` · ${load.unknown} unmeasured` : ""}`;
}
