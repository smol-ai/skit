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

function githubCoordinate(source: SkitSource): string | undefined {
  if (source.type !== "git") return undefined;
  const reference = source.ref.split("#", 1)[0];
  if (!reference) return undefined;
  const url = URL.parse(reference);
  if (!url || url.hostname.toLowerCase() !== "github.com") return undefined;
  const segments = url.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  if (segments.length !== 2) return undefined;
  const [owner, repository] = segments;
  if (!owner || !repository) return undefined;
  return `github:${owner.toLowerCase()}/${repository.replace(/\.git$/i, "").toLowerCase()}`;
}

export function dedicatedInstallerForSource(
  source: SkitSource,
): DedicatedInstallerGuidance | undefined {
  const coordinate = githubCoordinate(source);
  return coordinate ? catalog.get(coordinate) : undefined;
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
