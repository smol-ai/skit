import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { serverDiscovery, type ServerDiscovery as ServerDiscoveryDocument } from "../discovery.js";
import { inspectHealth } from "../health.js";
import { noStore } from "./response.js";
import { SkitApi } from "./system.js";

export const makeSystemHandlers = (discovery: ServerDiscoveryDocument) =>
  HttpApiBuilder.group(SkitApi, "system", (handlers) =>
    Effect.succeed(
      handlers.handleAll({
        health: () => noStore.pipe(Effect.andThen(inspectHealth())),
        agentSkillsDiscovery: () => noStore.pipe(Effect.as(discovery)),
        skitDiscovery: () => noStore.pipe(Effect.as(discovery)),
      }),
    ),
  );

export const systemHandlers = makeSystemHandlers(serverDiscovery);

// Canonical Effect rc.112 shape: ai-docs/src/51_http-server/10_basics.ts:33.
// The handler layer stays separate so HttpApiTest can provide it directly.
export const systemApi = HttpApiBuilder.layer(SkitApi);
