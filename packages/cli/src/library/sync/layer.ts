import { SkitConfiguration } from "@smolai/skit-core";
import { Effect, Layer } from "effect";
import { Library } from "@smolai/skit-core/library";

/** The executable's Sync root supplies routing once; the owner keeps its storage private. */
export const syncLibraryApplicationLayer = (
  roots: import("@smolai/skit-core/library/routing").InventoryRootOptions,
) =>
  Layer.unwrap(
    Effect.map(SkitConfiguration, (paths) =>
      Library.layer({ home: paths.skitHome, routing: { _tag: "Configured", ...roots } }),
    ),
  );
