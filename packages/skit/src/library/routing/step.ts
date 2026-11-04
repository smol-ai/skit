import { Effect } from "effect";
import type { InstallScope } from "../../vocabulary.js";
import type { LibraryState } from "../library-state.js";
import type { StepRouting } from "../store/state-schema.js";
import { readableSkillsDirectories } from "./duplicates.js";
import {
  activeInstallDestinations,
  skillsDirectoryFor,
  type InventoryRootOptions,
} from "./roots.js";

/**
 * Where setup installs and which folders agents read, resolved from this machine's configuration
 * once, so a re-run of a step after a crash routes exactly as this one did.
 */
export const stepRouting = Effect.fn("Setup.stepRouting")(function* (
  roots: InventoryRootOptions,
  state: LibraryState,
) {
  const active = yield* activeInstallDestinations(roots);
  const scopes: readonly InstallScope[] = [
    { kind: "global" },
    ...state.repositories.map((repository) => ({
      kind: "repository" as const,
      root: repository.root,
    })),
  ];
  return {
    active,
    destinations: scopes.flatMap((scope) =>
      active.map((destination) => ({
        scope,
        destination,
        root: skillsDirectoryFor(destination, scope, roots),
      })),
    ),
    readable: scopes.flatMap((scope) =>
      readableSkillsDirectories(roots, scope).map(({ harness, root }) => ({
        scope,
        harness,
        root,
      })),
    ),
  } satisfies StepRouting;
});
