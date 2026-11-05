// Runtime-neutral Authoring and Publication protocols, with their History vocabulary.

export {
  skitDescriptorRequestSchema,
  skitValidationDiagnosticsSchema,
  SkitCreateRequest,
  RevisionPostRequest,
  RevisionPostResponse,
  CurrentMoveRequest,
  SkitCurrentResponse,
  RevisionReadResponse,
  RevisionPage,
  MAX_ARTIFACT_FILES,
  MAX_ARTIFACT_CONTENT_BYTES,
  MAX_RELEASE_ARCHIVE_BYTES,
  MAX_PROJECTED_SKILL_BYTES,
  MAX_PROJECTED_RELEASE_BYTES,
  MAX_PROJECTED_SKILL_ENTRIES,
  MAX_PROJECTED_RELEASE_ENTRIES,
  MAX_RELEASE_ARCHIVE_BASE64_LENGTH,
  releasePublishRequestSchema,
} from "./api/authoring-contracts.js";
export * as History from "./history/history.js";
