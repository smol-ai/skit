import { join } from "node:path";
import type { HarnessName } from "@smolai/skit-core";

export interface LibraryInstallationConfiguration {
  readonly statePath: string;
  readonly variantsPath: string;
  readonly rootFor: (harness: HarnessName) => string | undefined;
}

/** Installation configuration only; never acquires or caches authoritative Library state. */
export function libraryInstallationConfiguration(
  home: string,
  roots: {
    readonly codex?: string;
    readonly claude?: string;
    readonly opencode?: string;
  },
): LibraryInstallationConfiguration {
  return {
    statePath: join(home, "state.json"),
    variantsPath: join(home, "variants"),
    rootFor: (harness) =>
      harness === "codex"
        ? roots.codex
        : harness === "claude-code"
          ? roots.claude
          : harness === "opencode"
            ? roots.opencode
            : undefined,
  };
}
