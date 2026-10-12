import { SkitConfiguration } from "../configuration/skit-configuration.js";
import { Effect, Layer } from "effect";
import { libraryAuditLogLayer, libraryStoreLayer, skitLayer } from "@smolai/skit-core";

/** Storage constructors consume the application boundary's required path snapshot. */
export const libraryApplicationLayer = Layer.unwrap(
  Effect.map(SkitConfiguration, (paths) =>
    Layer.mergeAll(
      libraryStoreLayer({ home: paths.skitHome }),
      libraryAuditLogLayer({ home: paths.skitHome }),
    ).pipe(Layer.provideMerge(skitLayer)),
  ),
);
