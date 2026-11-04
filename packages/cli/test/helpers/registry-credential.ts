import { ConfigProvider, Layer } from "effect";
import { skitConfigurationLayer } from "../../src/configuration/skit-configuration.js";

/**
 * The SKIT configuration of a shell whose environment holds a token for `origin` only, as
 * `SKIT_SERVER_URL` and `SKIT_TOKEN`. A command sends it to that Registry and to no other.
 */
export const registryCredentialLayer = (origin: string, token = "test-token") =>
  skitConfigurationLayer().pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ SKIT_SERVER_URL: origin, SKIT_TOKEN: token }),
      ),
    ),
  );
