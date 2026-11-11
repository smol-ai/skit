import { Schema } from "effect";
import { DescriptorFailure } from "../artifact/failures.js";
import { HarnessMetadataInvalid } from "../harnesses/metadata-failures.js";
import { TreeError } from "../shared/tree-error.js";
import { PlatformErrorSchema } from "../platform/error-schema.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { ImportContentInvalid } from "./failures.js";

/** Checked failures reading the exact selected source's invocation preference. */
export const AuthorInvocationFailure = Schema.Union([
  DescriptorFailure,
  HarnessMetadataInvalid,
  TreeError,
  PlatformErrorSchema,
  ImportContentInvalid,
]).annotate({ identifier: "AuthorInvocationFailure" });
export type AuthorInvocationFailure = typeof AuthorInvocationFailure.Type;

/** A policy change cannot be validated while its author's preference cannot be read. */
export class InvocationUnavailable
  extends Schema.TaggedError<InvocationUnavailable, { readonly brand: unique symbol }>()(
    "Library.InvocationUnavailable",
    { failure: AuthorInvocationFailure },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}
