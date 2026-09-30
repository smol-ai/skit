import type { SkillMetadata } from "../workflows/library/skill-metadata.js";
import { homedir } from "node:os";
import { sep } from "node:path";

export const metadataDate = (timestamp: string | null): string =>
  timestamp === null ? "unavailable" : timestamp.slice(0, 10);

export const metadataSource = (source: string | null): string =>
  source === null
    ? "unavailable"
    : source.startsWith(`${homedir()}${sep}`)
      ? `~${source.slice(homedir().length)}`
      : source;

export const metadataRevision = (revision: string | null): string =>
  revision === null
    ? "unavailable"
    : /^[a-f0-9]{40,64}$/i.test(revision)
      ? revision.slice(0, 12)
      : revision;

export const skillMetadataLines = (metadata: SkillMetadata): readonly string[] => [
  `Source: ${metadataSource(metadata.source)}`,
  `Revision: ${metadataRevision(metadata.revision)}`,
  `Source updated: ${metadataDate(metadata.source_updated_at)}`,
  `Acquired: ${metadataDate(metadata.acquired_at)}`,
];
