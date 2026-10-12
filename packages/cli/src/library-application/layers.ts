import { Layer } from "effect";
import { libraryAuditLogLayer, libraryStoreLayer, skitLayer } from "@smolai/skit-core";

/** Shared local environment. Front ends supply their own progress and presentation adapters. */
export function libraryApplicationLayer(home: string) {
  return Layer.mergeAll(libraryStoreLayer({ home }), libraryAuditLogLayer({ home })).pipe(
    Layer.provideMerge(skitLayer),
  );
}
