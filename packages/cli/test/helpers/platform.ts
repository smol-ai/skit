import { Layer } from "effect";
import { skitLayer } from "@smolai/skit-core";
import { skitConfigurationLayer } from "../../src/configuration/skit-configuration.js";

/** Standalone adapters receive the same explicit path boundary as executables. */
export const testPlatformLayer = Layer.merge(skitLayer, skitConfigurationLayer());
