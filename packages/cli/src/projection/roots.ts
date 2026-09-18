import { resolve } from "node:path";
import {
  harnessProfile,
  projectionRoot,
  resolveHarnessRoot,
  deduplicateInventoryRoots,
  type HarnessName,
  type SkitBindingScope,
  type LibraryState,
  type InventoryScanRoot,
} from "@smolai/skit-core";
export interface InventoryRootOptions {
  readonly home: string;
  readonly configHome: string;
  readonly overrides: {
    readonly codex?: string;
    readonly claude?: string;
    readonly opencode?: string;
    readonly devin?: string[];
  };
}
export function resolveLibraryRoots(
  harness: HarnessName,
  scope: SkitBindingScope,
  options: InventoryRootOptions,
): { codex?: string; claude?: string; opencode?: string; devin?: string[] } {
  if (harness === "devin") {
    const context = {
      home: options.home,
      configHome: options.configHome,
      ...(scope.kind === "repository" ? { repository: scope.root } : {}),
    };
    const profile = harnessProfile("devin");
    const target = projectionRoot(
      "devin",
      scope.kind === "global" ? "global" : "project",
      context,
    )!;
    return {
      devin: [
        target,
        ...profile.roots
          .filter((root) => root.scope === scope.kind && root.readable)
          .map((root) => resolveHarnessRoot(root, context))
          .filter((root) => root !== target),
        ...(options.overrides.devin ?? []).map((root) => resolve(root)),
      ],
    };
  }
  if (scope.kind === "global" && harness === "codex")
    return {
      codex: resolve(options.overrides.codex ?? projectionRoot("codex", "global", options)!),
    };
  if (scope.kind === "global" && harness === "claude-code")
    return {
      claude: resolve(
        options.overrides.claude ?? projectionRoot("claude-code", "global", options)!,
      ),
    };
  if (scope.kind === "global")
    return {
      opencode: resolve(
        options.overrides.opencode ?? projectionRoot("opencode", "global", options)!,
      ),
    };
  const target = projectionRoot(harness, "project", {
    home: options.home,
    configHome: options.configHome,
    repository: scope.root,
  })!;
  if (harness === "codex") return { codex: target };
  if (harness === "claude-code") return { claude: target };
  return { opencode: target };
}
/** Resolve one writable physical Skill root from device Harness configuration. */
export function bindingRoot(
  harness: HarnessName,
  scope: SkitBindingScope,
  options: InventoryRootOptions,
) {
  const roots = resolveLibraryRoots(harness, scope, options);
  const root =
    harness === "codex"
      ? roots.codex
      : harness === "claude-code"
        ? roots.claude
        : harness === "opencode"
          ? roots.opencode
          : roots.devin?.[0];
  return root === undefined ? undefined : resolve(root);
}
export function selectInventoryRoots(
  state: LibraryState,
  options: InventoryRootOptions,
): InventoryScanRoot[] {
  const bindings = [...state.global_bindings, ...state.local_bindings];
  const selections = [
    ...(["codex", "claude-code", "opencode", "devin"] as const).map((harness) =>
      resolveLibraryRoots(harness, { kind: "global" }, options),
    ),
    ...bindings.map((binding) => resolveLibraryRoots(binding.harness, binding.scope, options)),
  ];
  return deduplicateInventoryRoots(
    selections.flatMap((selection) => [
      ...(selection.codex ? [{ harness: "codex" as const, root: selection.codex }] : []),
      ...(selection.claude ? [{ harness: "claude-code" as const, root: selection.claude }] : []),
      ...(selection.opencode ? [{ harness: "opencode" as const, root: selection.opencode }] : []),
      ...(selection.devin ?? []).map((root) => ({ harness: "devin" as const, root })),
    ]),
  );
}
