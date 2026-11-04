import { Effect, Layer } from "effect";
import { InstalledSkills, SkitConfiguration } from "@smolai/skit-core";
import { Library } from "@smolai/skit-core/library";

/** Acquire the real owner over the configured home, after a test supplies its faulting filesystem. */
export const withLibraryOwner = Effect.provide(
  Layer.fresh(
    Layer.effect(
      Library.Service,
      Effect.flatMap(SkitConfiguration, (paths) => Library.make(paths.skitHome)),
    ).pipe(Layer.provide(InstalledSkills.layer())),
  ),
);
