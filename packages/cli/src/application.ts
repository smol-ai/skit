import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { consoleRendererLayer } from "./terminal/console-renderer.js";
import { registryHttpLayer } from "./registry/registry-http.js";
import {
  configurationForHome,
  SkitConfiguration,
  skitConfigurationLayer,
} from "@smolai/skit-core/platform";
import * as Library from "@smolai/skit-core/library";
import { inventoryRootOptions } from "@smolai/skit-core/library/routing";
import { rootOverrides, type RootFlags } from "./commands/parameters.js";

/** Parsed configuration flags. Grouped commands inherit home from their parent. */
type CommandInput = { readonly home?: string } & Partial<RootFlags>;

/** Select home from the existing process snapshot; do not resolve its environment again. */
export const configurationLayer = (input: CommandInput = {}) =>
  Layer.effect(SkitConfiguration, configurationForHome(input.home));

/** One configured Library for the selected command; its implementation owns startup recovery. */
export const libraryLayer = (input: CommandInput = {}) =>
  Layer.unwrap(
    Effect.map(configurationForHome(input.home), (paths) =>
      Layer.merge(
        Layer.succeed(SkitConfiguration, paths),
        Library.layer({
          home: paths.skitHome,
          roots: inventoryRootOptions(paths, rootOverrides(input)),
        }),
      ),
    ),
  );

/** Source commands use Library and Registry transport, without constructing Author owners. */
export const sourceLayer = (input: CommandInput = {}) =>
  Layer.merge(libraryLayer(input), registryHttpLayer());

/** Process services for the executable and command metadata tools; never opens Library. */
export const cliLayer = (json: boolean, home?: string) =>
  Layer.mergeAll(skitConfigurationLayer(home), consoleRendererLayer(json), NodeServices.layer);
