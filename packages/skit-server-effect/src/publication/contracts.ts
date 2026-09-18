import {
  MAX_RELEASE_ARCHIVE_BASE64_LENGTH,
  MAX_RELEASE_ARCHIVE_BYTES,
  releasePublishRequestSchema,
  releasePublishResponseSchema,
  releaseSchema,
} from "@smolai/skit-core/universal/authoring";

export { MAX_RELEASE_ARCHIVE_BASE64_LENGTH, MAX_RELEASE_ARCHIVE_BYTES };
export const MAX_PUBLISH_REQUEST_BYTES = MAX_RELEASE_ARCHIVE_BASE64_LENGTH + 4_096;
export const ReleasePublishRequest = releasePublishRequestSchema;
export type ReleasePublishRequest = typeof ReleasePublishRequest.Type;
export const PublishedRelease = releaseSchema;
export const ReleasePublishResponse = releasePublishResponseSchema;
