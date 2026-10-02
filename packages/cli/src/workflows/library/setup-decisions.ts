import { Schema } from "effect";
import type { HarnessShadow } from "../../projection/harness-shadows.js";
import type { SetupResult } from "./setup-contract.js";

export const SetupDuplicateAction = Schema.Literals(["retain-only", "retire-aliases", "keep-both"]);
export type SetupDuplicateAction = typeof SetupDuplicateAction.Type;

/** Evidence authorizing these individual links, independently of later setup stages. */
export const SetupApprovedAlias = Schema.Struct({
  path: Schema.String,
  canonicalPath: Schema.String,
  linkTarget: Schema.String,
  dev: Schema.Number,
  ino: Schema.Number,
});
export interface SetupApprovedAlias extends Schema.Schema.Type<typeof SetupApprovedAlias> {}

/** Every relevant alias must be an individual link to the selected canonical source. */
export function retirableShadowAliases(sourcePath: string, shadows: readonly HarnessShadow[]) {
  if (
    !shadows.length ||
    shadows.some(
      (shadow) =>
        shadow.canonicalPath !== sourcePath ||
        shadow.aliases.some((alias) => alias.via !== "symlink" || alias.linkPath !== alias.path),
    )
  )
    return [];
  return [
    ...new Set(shadows.flatMap((shadow) => shadow.aliases.map((alias) => alias.path))),
  ].sort();
}

export type SetupCopyConflict =
  | { readonly kind: "none" }
  | {
      readonly kind: "retirable" | "preserve-copies";
      readonly shadows: readonly HarnessShadow[];
      readonly aliases: readonly string[];
    };

/** Shared applicability and allowed actions for prompting and both mutation validators. */
export function copyConflict(
  observed: SetupResult,
  selection: { readonly name: string; readonly sourcePath: string },
): SetupCopyConflict {
  const candidate = observed.onboarding.candidates.find(
    (item) => item.name === selection.name && item.paths.includes(selection.sourcePath),
  );
  const instance = observed.instances.find((item) => item.path === selection.sourcePath);
  const shadows = candidate?.shadows ?? [];
  if (
    !shadows.length ||
    instance?.scope !== "global" ||
    instance.git.repository ||
    !instance.harnesses.length ||
    candidate?.action === "repository-owned"
  )
    return { kind: "none" };
  const aliases = retirableShadowAliases(selection.sourcePath, shadows);
  return { kind: aliases.length ? "retirable" : "preserve-copies", shadows, aliases };
}

export const SetupCopySelection = Schema.Struct({
  name: Schema.String,
  sourcePath: Schema.String,
  duplicateAction: Schema.optionalKey(SetupDuplicateAction),
  approvedAliases: Schema.optionalKey(Schema.Array(SetupApprovedAlias)),
});
export interface SetupCopySelection extends Schema.Schema.Type<typeof SetupCopySelection> {}

export interface SetupSelectedCopy {
  readonly operation: "add" | "bind";
  readonly name: string;
  readonly sourcePath: string;
  readonly conflict: SetupCopyConflict;
}

export type SetupCopyDecision = SetupSelectedCopy &
  (
    | { readonly duplicateAction?: never; readonly approvedAliases?: never }
    | { readonly duplicateAction: "retain-only" | "keep-both"; readonly approvedAliases?: never }
    | {
        readonly duplicateAction: "retire-aliases";
        readonly approvedAliases: readonly SetupApprovedAlias[];
      }
  );

export function setupSelectedCopies(
  observed: SetupResult,
  add: readonly { readonly name: string; readonly sourcePath: string }[],
  bind: readonly { readonly name: string; readonly path: string }[],
): SetupSelectedCopy[] {
  return [
    ...add.map((selection) => ({ ...selection, operation: "add" as const })),
    ...bind.map(({ name, path }) => ({ name, sourcePath: path, operation: "bind" as const })),
  ].map((copy) => ({ ...copy, conflict: copyConflict(observed, copy) }));
}
