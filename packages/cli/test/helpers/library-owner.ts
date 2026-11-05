import { Effect, Layer } from "effect";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Library } from "@smolai/skit-core/library";
/** Acquire the public owner after the test supplies its faulting filesystem. */
export const withLibraryOwner = Effect.provide(
  Layer.fresh(
    Layer.unwrap(
      Effect.map(SkitConfiguration, (paths) =>
        Library.layer({ home: paths.skitHome, routing: { _tag: "Recorded" } }),
      ),
    ),
  ),
);
