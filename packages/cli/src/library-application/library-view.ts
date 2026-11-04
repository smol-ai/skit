import { Effect } from "effect";
import { SkitConfiguration } from "@smolai/skit-core";
import * as Session from "@smolai/skit-core/library/session";
export { libraryView } from "@smolai/skit-core/library/session";
export const openLibraryView = () =>
  Effect.flatMap(SkitConfiguration, (paths) => Session.openLibraryView(paths.skitHome));
