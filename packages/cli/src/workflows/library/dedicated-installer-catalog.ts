import { parseSkitSourceEffect, type SkitSource } from "@smolai/skit-core";
import { Data, Effect } from "effect";

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

export class DedicatedInstallerRequired extends Data.TaggedError(
  "Library.DedicatedInstallerRequired",
)<DedicatedInstallerGuidance> {
  readonly code = "INVALID_ARGUMENT" as const;
  readonly exitCode = 64;

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

/** Stop before acquisition when the Source explicitly requires its own installer. */
export const rejectDedicatedInstallerSourceEffect = Effect.fn(
  "Library.rejectDedicatedInstallerSource",
)(function* (input: string) {
  const source = yield* parseSkitSourceEffect(input);
  const guidance = dedicatedInstallerForSource(source);
  if (guidance) return yield* new DedicatedInstallerRequired(guidance);
  return source;
});
