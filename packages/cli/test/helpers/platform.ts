import { Layer } from "effect";
import { skitLayer } from "@smolai/skit-core";
import { skitConfigurationLayer } from "@smolai/skit-core";
import { AuthorWorkspace } from "../../src/author/workspace.js";

/** Standalone adapters receive the same explicit path boundary as executables. */
export const testPlatformLayer = Layer.mergeAll(
  skitLayer,
  skitConfigurationLayer(),
  AuthorWorkspace.layer.pipe(Layer.provide(skitLayer)),
);
