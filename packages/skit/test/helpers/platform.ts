import { Layer } from "effect";
import { skitLayer, skitConfigurationLayer } from "../../src/platform/index.js";

import { authorWorkspaceLayer } from "../../src/author/index.js";

/** Standalone adapters receive the same explicit path boundary as executables. */
export const testPlatformLayer = Layer.mergeAll(
  skitLayer,
  skitConfigurationLayer(),
  authorWorkspaceLayer.pipe(Layer.provide(skitLayer)),
);
