import { Layer } from "effect";
import { skitLayer } from "@smolai/skit-core";
import { skitPathsLayer } from "../../src/configuration/paths.js";

/** Standalone adapters receive the same explicit path boundary as executables. */
export const testPlatformLayer = Layer.merge(skitLayer, skitPathsLayer());
