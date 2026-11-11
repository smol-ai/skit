import type { SkitSource } from "../library/library-contracts.js";
import { Schema, Effect } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export const DedicatedInstallerGuidance = Schema.Struct({
  sourceCoordinate: Schema.String,
  displayName: Schema.String,
  command: Schema.String,
  documentationUrl: Schema.String,
});
export type DedicatedInstallerGuidance = typeof DedicatedInstallerGuidance.Type;

const catalog = new Map<string, DedicatedInstallerGuidance>([
  [
    "github:pbakaus/impeccable",
    {
      sourceCoordinate: "github:pbakaus/impeccable",
      displayName: "Impeccable",
      command: "npx impeccable install",
      documentationUrl: "https://github.com/pbakaus/impeccable#installation",
    },
  ],
]);

export class DedicatedInstallerRequired
  extends Schema.TaggedError<DedicatedInstallerRequired, { readonly brand: unique symbol }>()(
    "Library.DedicatedInstallerRequired",
    DedicatedInstallerGuidance.fields,
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export function dedicatedInstallerForSource(
  source: SkitSource,
): DedicatedInstallerGuidance | undefined {
  return source.type === "github"
    ? catalog.get(`github:${source.owner.toLowerCase()}/${source.repository.toLowerCase()}`)
    : undefined;
}

/** Source admissibility is checked before any acquisition, for every caller. */
export const checkSourceInstaller = Effect.fn("Library.checkSourceInstaller")(function* (
  source: SkitSource,
) {
  const guidance = dedicatedInstallerForSource(source);
  if (guidance) return yield* new DedicatedInstallerRequired(guidance);
});
