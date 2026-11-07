import type { Effect } from "effect";
import type * as Library from "@smolai/skit-core/library";

export const largeCollectionWarning = (count: number): string | undefined =>
  count > 100
    ? `Large skill listing (${count} skills). Run skit doctor to check description visibility.`
    : undefined;

export function descriptionLoadMessage(
  load: Effect.Success<ReturnType<Library.Interface["descriptionLoad"]>>,
): string {
  return `${load.skills} skills · ${load.characters.toLocaleString("en-US")} description characters${load.unknown ? ` · ${load.unknown} unmeasured` : ""}`;
}
