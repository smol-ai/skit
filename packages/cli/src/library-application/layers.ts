import { SkitConfiguration, skitConfigurationLayer } from "../configuration/skit-configuration.js";
import { Effect, Layer } from "effect";
import { libraryAuditLogLayer, libraryStoreLayer, skitLayer } from "@smolai/skit-core";

/** Storage constructors consume the application boundary's required path snapshot. */
export const libraryApplicationFromConfiguration = Layer.unwrap(
  Effect.map(SkitConfiguration, (paths) =>
    Layer.mergeAll(
      libraryStoreLayer({ home: paths.skitHome }),
      libraryAuditLogLayer({ home: paths.skitHome }),
    ).pipe(Layer.provideMerge(skitLayer)),
  ),
);

/** Standalone front ends construct their path boundary once. */
export const libraryApplicationLayer = (home?: string) =>
  libraryApplicationFromConfiguration.pipe(Layer.provideMerge(skitConfigurationLayer(home)));
