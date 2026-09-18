import {
  containedSkillSchema,
  digestSchema,
  InvocationPolicy as CoreInvocationPolicy,
  safePathSchema,
  sharedMappingSchema,
  skitConfigSchema,
  skitDescriptorSchema,
} from "@smolai/skit-core/universal/consumer";
import { IntegrityErrorCode } from "@smolai/skit-core/universal/api";
import { Schema } from "effect";

export const Digest = digestSchema;
export type Digest = typeof Digest.Type;
export const InvocationPolicy = CoreInvocationPolicy;
export type InvocationPolicy = typeof InvocationPolicy.Type;
export const SharedMapping = sharedMappingSchema;
export type SharedMapping = typeof SharedMapping.Type;
export const ContainedSkill = containedSkillSchema;
export type ContainedSkill = typeof ContainedSkill.Type;
export const SkitConfig = skitConfigSchema;
export type SkitConfig = typeof SkitConfig.Type;
export const SkitDescriptor = skitDescriptorSchema;
export type SkitDescriptor = typeof SkitDescriptor.Type;

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const MAX_ARTIFACT_CONTENT_BYTES = 25 * 1024 * 1024;

export const ArtifactFile = Schema.Struct({
  path: safePathSchema,
  bytes: Schema.Uint8Array,
  digest: Digest,
  media_type: NonEmptyString,
  executable: Schema.Boolean,
});
export interface ArtifactFile extends Schema.Schema.Type<typeof ArtifactFile> {}

export const ValidationDiagnostic = Schema.Struct({
  code: NonEmptyString,
  severity: Schema.Literal("error"),
  path: safePathSchema,
  message: NonEmptyString,
});
export interface ValidationDiagnostic extends Schema.Schema.Type<typeof ValidationDiagnostic> {}

export { IntegrityErrorCode } from "@smolai/skit-core/universal/api";

export class IntegrityError extends Schema.TaggedError<IntegrityError>()("Integrity.Error", {
  code: IntegrityErrorCode,
  detail: Schema.optionalKey(Schema.String),
}) {}
