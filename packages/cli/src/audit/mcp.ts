import {
  arrayAt,
  booleanAt,
  isJsonObject,
  stringAt,
  type HarnessName,
  type JsonObject,
} from "@smolai/skit-core";
import type { AuditObservation } from "./types.js";

export function addMcp(
  observations: AuditObservation[],
  configPath: string,
  harness: HarnessName,
  scope: "user" | "project" | "legacy",
  servers: JsonObject | undefined,
  active: boolean,
): void {
  for (const [name, config] of Object.entries(servers ?? {})) {
    const entry = isJsonObject(config) ? config : {};
    const enabled = booleanAt(entry, "enabled") !== false;
    const command = stringAt(entry, "command") ?? undefined;
    const url = stringAt(entry, "url") ?? undefined;
    const cwd = stringAt(entry, "cwd") ?? undefined;
    const configuredType = stringAt(entry, "type");
    const transport = command
      ? "stdio"
      : configuredType === "sse"
        ? "sse"
        : url
          ? "http"
          : "unknown";
    observations.push({
      kind: "mcp-server",
      name,
      harnesses: [harness],
      scope,
      path: configPath,
      source: command ?? url,
      mcp: {
        transport,
        ...(command ? { command } : {}),
        args: arrayAt(entry, "args").filter((arg): arg is string => typeof arg === "string"),
        ...(cwd ? { cwd } : {}),
        ...(url ? { url } : {}),
      },
      enabled,
      active: active && enabled,
      provenance: { confidence: "exact", source: "configuration", evidence: configPath },
    });
  }
}
