import { SkitConfiguration } from "@smolai/skit-core";
import { Effect, Layer } from "effect";
import { skitLayer } from "@smolai/skit-core";
import { Library } from "@smolai/skit-core/library";
import { AuthorWorkspace } from "../author/workspace.js";

/** Storage constructors consume the application boundary's required path snapshot. */
export const libraryApplicationLayer = Layer.unwrap(
  Effect.map(SkitConfiguration, (paths) =>
    Layer.mergeAll(
      Library.layer({ home: paths.skitHome, routing: { _tag: "None" } }),
      // Removing an authored Collection marks its workspace (A15); `author init` registers one.
      AuthorWorkspace.layer,
    ).pipe(Layer.provideMerge(skitLayer)),
  ),
);

/** The executable's Sync root supplies routing once; the owner keeps its storage private. */
export const syncLibraryApplicationLayer = (
  roots: import("@smolai/skit-core/library/routing").InventoryRootOptions,
) =>
  Layer.unwrap(
    Effect.map(SkitConfiguration, (paths) =>
      Library.layer({ home: paths.skitHome, routing: { _tag: "Configured", ...roots } }),
    ),
  );
