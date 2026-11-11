import {
  SourceRestoreInvalid,
  SourceRestoreReason,
} from "@smolai/skit-core/library/source-restore/failures";

export const sourceRestoreFailure = (
  { hash, reason }: SourceRestoreInvalid,
  formatFailure: (error: unknown) => string,
) => ({
  message: `Cannot restore Collection Version ${hash}: ${SourceRestoreReason.match(reason, {
    SourceImportMissing: () => "manifest has no exact Source Import",
    NormalizationProfiles: ({ profiles }) =>
      `Collection Version needs one normalization profile; found ${profiles.length}: ${profiles.join(", ")}`,
    DescriptorMissing: () => "declared Collection Version Source has no declared Descriptor",
    SourceFetchFailed: ({ failure }) => formatFailure(failure),
    HashMismatch: ({ actual }) => `source returned ${actual} instead of ${hash}`,
  })}`,
  remediation: "Restore access to the source, or update the Collection, then sync again.",
});
