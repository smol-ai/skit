import { Layer } from "effect";
import { skitLayer, skitConfigurationLayer } from "@smolai/skit-core";

import { AuthorWorkspace } from "@smolai/skit-core/author";

/** Standalone adapters receive the same explicit path boundary as executables. */
export const testPlatformLayer = Layer.mergeAll(
  skitLayer,
  skitConfigurationLayer(),
  AuthorWorkspace.layer.pipe(Layer.provide(skitLayer)),
);
