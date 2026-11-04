import { Effect, Layer } from "effect";
import { InstalledSkills } from "@smolai/skit-core";
import { Library } from "@smolai/skit-core/library";

/** Acquire the real owner after a test supplies its faulting store or filesystem. */
export const withLibraryOwner = Effect.provide(
  Layer.fresh(
    Layer.effect(Library.Service, Library.make).pipe(Layer.provide(InstalledSkills.layer())),
  ),
);
