import { SkitConfiguration } from "../configuration/skit-configuration.js";
import { Effect, Layer } from "effect";
import { InstalledSkills, libraryStoreLayer, skitLayer } from "@smolai/skit-core";
import { Library } from "@smolai/skit-core/library";
import { AuthorWorkspace } from "../author/workspace.js";

/** Storage constructors consume the application boundary's required path snapshot. */
export const libraryApplicationLayer = Layer.unwrap(
  Effect.map(SkitConfiguration, (paths) =>
    Layer.mergeAll(
      Library.layer.pipe(
        Layer.provide(InstalledSkills.layer()),
        Layer.provideMerge(libraryStoreLayer({ home: paths.skitHome })),
      ),
      // Removing an authored Collection marks its workspace (A15); `author init` registers one.
      AuthorWorkspace.layer,
    ).pipe(Layer.provideMerge(skitLayer)),
  ),
);
