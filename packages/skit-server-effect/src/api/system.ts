import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { ServerDiscovery } from "../discovery.js";
import { HealthResponse } from "../health.js";

export class SystemApi extends HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", "/health", { success: HealthResponse }),
  HttpApiEndpoint.get("agentSkillsDiscovery", "/.well-known/agent-skills/", {
    success: ServerDiscovery,
  }),
  HttpApiEndpoint.get("skitDiscovery", "/.well-known/skit", {
    success: ServerDiscovery,
  }),
) {}

export class SkitApi extends HttpApi.make("skit-server").add(SystemApi) {}
