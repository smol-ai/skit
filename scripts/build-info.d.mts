import type { BuildInfo } from "../packages/skit/src/build-info.js";
export function buildInfo(
  metadata: { name: string; version: string },
  environment?: NodeJS.ProcessEnv,
): BuildInfo;
