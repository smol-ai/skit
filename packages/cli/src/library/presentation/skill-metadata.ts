import type { SkillMetadata } from "@smolai/skit-core/library/queries";
import { homedir } from "node:os";
import { sep } from "node:path";

export const metadataDate = (timestamp: string | null): string =>
  timestamp === null
    ? "unavailable"
    : new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(timestamp));

export const metadataSource = (source: string | null): string =>
  source === null
    ? "unavailable"
    : source.startsWith(`${homedir()}${sep}`)
      ? `~${source.slice(homedir().length)}`
      : source;

export const metadataRevision = (revision: string | null): string =>
  revision === null
    ? "unavailable"
    : /^sha256:[a-f0-9]{64}$/i.test(revision)
      ? revision.slice(0, 19)
      : /^[a-f0-9]{40,64}$/i.test(revision)
        ? revision.slice(0, 12)
        : revision;

export const skillMetadataLines = (metadata: SkillMetadata): readonly string[] => [
  ...(metadata.source === null ? [] : [`Source: ${metadataSource(metadata.source)}`]),
  ...(metadata.revision === null ? [] : [`Revision: ${metadataRevision(metadata.revision)}`]),
  ...(metadata.saved_at === undefined ? [] : [`Saved: ${metadataDate(metadata.saved_at)}`]),
  ...(metadata.source_updated_at === null
    ? []
    : [`Source updated: ${metadataDate(metadata.source_updated_at)}`]),
  ...(metadata.imported_at === null ? [] : [`Imported: ${metadataDate(metadata.imported_at)}`]),
];
