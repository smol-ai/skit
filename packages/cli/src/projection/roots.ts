import { resolve } from "node:path";
import { Effect } from "effect";
import {
  harnessProfile,
  projectionRoot,
  projectionTargetRoot,
  resolveHarnessRoot,
  deduplicateInventoryRoots,
  type HarnessName,
  type ProjectionTarget,
  type SkitBindingScope,
  type LibraryState,
  type InventoryScanRoot,
} from "@smolai/skit-core";
import { detectInstalledHarnessesEffect } from "../harness/catalog.js";
export interface InventoryRootOptions {
  readonly home: string;
  readonly configHome: string;
  readonly overrides: {
    /** The shared `.agents/skills` root, which Codex reads natively. */
    readonly codex?: string;
    readonly claude?: string;
    readonly opencode?: string;
    readonly devin?: string[];
  };
}

/** Resolve one target's writable physical Skill root for a Scope. */
export function bindingRoot(
  target: ProjectionTarget,
  scope: SkitBindingScope,
  options: InventoryRootOptions,
): string {
  const override = target === "agents" ? options.overrides.codex : options.overrides.claude;
  if (scope.kind === "global" && override !== undefined) return resolve(override);
  return resolve(
    projectionTargetRoot(target, scope.kind === "global" ? "global" : "project", {
      home: options.home,
      configHome: options.configHome,
      ...(scope.kind === "repository" ? { repository: scope.root } : {}),
    }),
  );
}

/** The targets this device materializes into: `.agents` always, `.claude` only with Claude Code. */
export const activeProjectionTargetsEffect = Effect.fn("Projection.activeTargets")(function* (
  options: InventoryRootOptions,
) {
  const detected = yield* detectInstalledHarnessesEffect({
    home: options.home,
    configHome: options.configHome,
    ...(options.overrides.claude === undefined ? {} : { claudeRoot: options.overrides.claude }),
  });
  return activeProjectionTargets(detected);
});

export const activeProjectionTargets = (
  detected: readonly HarnessName[],
): readonly ProjectionTarget[] =>
  detected.includes("claude-code") ? ["agents", "claude"] : ["agents"];

/** Every Harness's own global roots, plus the target roots of each repository Binding. */
export function selectInventoryRoots(
  state: LibraryState,
  options: InventoryRootOptions,
): InventoryScanRoot[] {
  const context = { home: options.home, configHome: options.configHome };
  const devin = harnessProfile("devin");
  return deduplicateInventoryRoots([
    { harness: "codex", root: bindingRoot("agents", { kind: "global" }, options) },
    { harness: "claude-code", root: bindingRoot("claude", { kind: "global" }, options) },
    {
      harness: "opencode",
      root: resolve(options.overrides.opencode ?? projectionRoot("opencode", "global", context)!),
    },
    ...devin.roots
      .filter((root) => root.scope === "global" && root.readable)
      .map((root) => ({ harness: "devin" as const, root: resolveHarnessRoot(root, context) })),
    ...(options.overrides.devin ?? []).map((root) => ({
      harness: "devin" as const,
      root: resolve(root),
    })),
    ...state.local_bindings.flatMap((binding) => [
      { harness: "codex" as const, root: bindingRoot("agents", binding.scope, options) },
      { harness: "claude-code" as const, root: bindingRoot("claude", binding.scope, options) },
    ]),
  ]);
}
