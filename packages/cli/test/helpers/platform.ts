import { Layer } from "effect";
import { skitLayer, skitConfigurationLayer } from "@smolai/skit-core/platform";

import { authorWorkspaceLayer } from "@smolai/skit-core/author";

/** Standalone adapters receive the same explicit path boundary as executables. */
export const testPlatformLayer = Layer.mergeAll(
  skitLayer,
  skitConfigurationLayer(),
  authorWorkspaceLayer.pipe(Layer.provide(skitLayer)),
);
