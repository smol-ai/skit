import type { Effect } from "effect";
import type { openLibraryView } from "@smolai/skit-core/library/session";

type LibraryView = Effect.Success<ReturnType<typeof openLibraryView>>;

export const largeCollectionWarning = (count: number): string | undefined =>
  count > 100
    ? `Large skill listing (${count} skills). Run skit doctor to check description visibility.`
    : undefined;

export function descriptionLoadMessage(
  load: Effect.Success<ReturnType<LibraryView["descriptionLoad"]>>,
): string {
  return `${load.skills} skills · ${load.characters.toLocaleString("en-US")} description characters${load.unknown ? ` · ${load.unknown} unmeasured` : ""}`;
}
