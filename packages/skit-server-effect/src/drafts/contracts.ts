import {
  draftCreateRequestSchema,
  draftFileInputSchema,
  draftReadResponseSchema,
  draftRevisionSchema,
  draftUpdateRequestSchema,
  draftWriteResponseSchema,
  skitDescriptorRequestSchema,
  skitValidationDiagnosticSchema,
} from "@smolai/skit-core/universal/authoring";
import { MAX_ARTIFACT_CONTENT_BYTES } from "../integrity/contracts.js";

export const MAX_DRAFT_CONTENT_BYTES = MAX_ARTIFACT_CONTENT_BYTES;
export const MAX_DRAFT_REQUEST_BYTES = Math.ceil(MAX_DRAFT_CONTENT_BYTES / 3) * 4 + 1024 * 1024;

export const WireDescriptor = skitDescriptorRequestSchema;
export type WireDescriptor = typeof WireDescriptor.Type;
export const DraftFileInput = draftFileInputSchema;
export type DraftFileInput = typeof DraftFileInput.Type;
export const Diagnostic = skitValidationDiagnosticSchema;
export type Diagnostic = typeof Diagnostic.Type;
export const DraftUpdateRequest = draftUpdateRequestSchema;
export type DraftUpdateRequest = typeof DraftUpdateRequest.Type;
export const DraftCreateRequest = draftCreateRequestSchema;
export type DraftCreateRequest = typeof DraftCreateRequest.Type;
export const DraftRevision = draftRevisionSchema;
export type DraftRevision = typeof DraftRevision.Type;
export const DraftWriteResponse = draftWriteResponseSchema;
export const DraftReadResponse = draftReadResponseSchema;
export type DraftReadResponse = typeof DraftReadResponse.Type;
