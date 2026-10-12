import { configurationPaths, SkitPaths } from "../configuration/paths.js";
import { Effect, Layer } from "effect";
import { libraryAuditLogLayer, libraryStoreLayer, skitLayer } from "@smolai/skit-core";

/** Shared local environment. Front ends supply their own progress and presentation adapters. */
export function libraryApplicationLayer(home?: string) {
  return Layer.unwrap(
    Effect.map(configurationPaths(home), (paths) =>
      Layer.mergeAll(
        libraryStoreLayer({ home: paths.skitHome }),
        libraryAuditLogLayer({ home: paths.skitHome }),
        Layer.succeed(SkitPaths, paths),
      ).pipe(Layer.provideMerge(skitLayer)),
    ),
  );
}
