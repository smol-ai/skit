import { Layer } from "effect";
import { skitConfigurationLayer } from "@smolai/skit-core";
import { sourceApplicationLayer } from "./commands/handler.js";
import { consoleRendererLayer } from "./terminal/console-renderer.js";

/** Full environment for contract generators and runners exercising multiple command families. */
export function commandApplicationLayer(json: boolean, home: string) {
  return Layer.merge(
    sourceApplicationLayer.pipe(Layer.provideMerge(skitConfigurationLayer(home))),
    consoleRendererLayer(json),
  );
}

export {
  renderCommandFailures,
  sourceApplicationLayer,
  commandFailure,
  libraryApplicationLayer,
} from "./commands/handler.js";
