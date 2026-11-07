import type { SkitSource } from "../library/library-contracts.js";
import { Data, Effect } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export interface DedicatedInstallerGuidance {
  readonly sourceCoordinate: string;
  readonly displayName: string;
  readonly command: string;
  readonly documentationUrl: string;
}

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
  extends Data.TaggedError("Library.DedicatedInstallerRequired")<DedicatedInstallerGuidance>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;

  get message(): string {
    return `${this.displayName} publishes harness-specific builds and cannot be added as one portable Skill Collection.`;
  }

  get remediation(): string {
    return `Run \`${this.command}\`. Installation guide: ${this.documentationUrl}`;
  }
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
