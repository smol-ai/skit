import { Effect, Layer } from "effect";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import * as Library from "@smolai/skit-core/library";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";
/** Acquire the public owner, routed from `roots`, after the test supplies its faulting filesystem. */
export const withLibraryOwner = (roots: InventoryRootOptions) =>
  Effect.provide(
    Layer.fresh(
      Layer.unwrap(
        Effect.map(SkitConfiguration, (paths) => Library.layer({ home: paths.skitHome, roots })),
      ),
    ),
  );
