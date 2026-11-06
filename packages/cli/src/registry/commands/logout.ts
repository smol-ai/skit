import { Effect } from "effect";
import { Registry } from "../index.js";
import { Renderer } from "../../terminal/renderer.js";

export const authLogoutCommand = Effect.fn("CLI.authLogout")(function* (
  home?: string,
  selectedOrigin?: string,
) {
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Revoking CLI credential",
    Effect.scoped(Registry.logout(home, selectedOrigin)),
  );
});
