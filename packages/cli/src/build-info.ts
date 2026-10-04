import type { BuildInfo } from "@smolai/skit-core";
declare const __SKIT_BUILD__: BuildInfo;
export const cliBuild: BuildInfo =
  typeof __SKIT_BUILD__ === "undefined" ? { kind: "dev", version: "0.0.0-dev" } : __SKIT_BUILD__;
