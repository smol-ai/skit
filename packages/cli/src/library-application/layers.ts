import { SkitPaths, skitPathsLayer } from "../configuration/paths.js";
import { Effect, Layer } from "effect";
import { libraryAuditLogLayer, libraryStoreLayer, skitLayer } from "@smolai/skit-core";

/** Storage constructors consume the application boundary's required path snapshot. */
export const libraryApplicationFromPaths = Layer.unwrap(
  Effect.map(SkitPaths, (paths) =>
    Layer.mergeAll(
      libraryStoreLayer({ home: paths.skitHome }),
      libraryAuditLogLayer({ home: paths.skitHome }),
    ).pipe(Layer.provideMerge(skitLayer)),
  ),
);

/** Standalone front ends construct their path boundary once. */
export const libraryApplicationLayer = (home?: string) =>
  libraryApplicationFromPaths.pipe(Layer.provideMerge(skitPathsLayer(home)));
