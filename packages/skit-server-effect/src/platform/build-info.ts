import type { BuildInfo } from "@smolai/skit-core/universal/consumer";
declare const __SKIT_SERVER_BUILD__: BuildInfo;
export const serverBuild: BuildInfo =
  typeof __SKIT_SERVER_BUILD__ === "undefined"
    ? { kind: "dev", version: "0.0.0-dev" }
    : __SKIT_SERVER_BUILD__;
