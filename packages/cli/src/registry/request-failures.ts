import { RegistryResponseFailure, registryResponseDetails } from "./response-failure.js";
import {
  FailureTypeId,
  type SkitFailure,
  SchemaFailure,
  errorMessage,
} from "@smolai/skit-core/shared";
import { Match, Schema } from "effect";
import { Block } from "../terminal/blocks.js";
import { describeFailure } from "../terminal/failure.js";
import { schemaFailureMessages } from "../platform/schema-failure.js";

// Native validation errors stay live; their existing codec stores schema facts at JSON boundaries.
// The unknown type side prevents class defaults from changing an unexpected live cause.
const RequestCause = Schema.Union([SchemaFailure, Schema.Defect()]).pipe(
  Schema.decodeTo(Schema.Unknown),
);

export class AuthorListResponseError
  extends Schema.TaggedError<AuthorListResponseError, { readonly brand: unique symbol }>()(
    "AuthorListResponseError",
    RegistryResponseFailure.fields,
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export class AuthorSkitNotFound
  extends Schema.TaggedError<AuthorSkitNotFound, { readonly brand: unique symbol }>()(
    "AuthorSkitNotFound",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  override get message(): string {
    return registryRequestFailure(this).message;
  }
}

export class AuthorDeleteResponseError
  extends Schema.TaggedError<AuthorDeleteResponseError, { readonly brand: unique symbol }>()(
    "AuthorDeleteResponseError",
    RegistryResponseFailure.fields,
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export class AuthorListPaginationError
  extends Schema.TaggedError<AuthorListPaginationError, { readonly brand: unique symbol }>()(
    "AuthorListPaginationError",
    {
      origin: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  override get message(): string {
    return registryRequestFailure(this).message;
  }
}

const AuthorRequestOperation = Schema.Literals([
  "current",
  "revision",
  "ancestors",
  "post",
  "move",
  "create",
]);
export class AuthorRequestFailed
  extends Schema.TaggedError<AuthorRequestFailed, { readonly brand: unique symbol }>()(
    "AuthorRequestFailed",
    {
      ...RegistryResponseFailure.fields,
      operation: AuthorRequestOperation,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
export class AuthorRequestTimedOut
  extends Schema.TaggedError<AuthorRequestTimedOut, { readonly brand: unique symbol }>()(
    "AuthorRequestTimedOut",
    {
      origin: Schema.String,
      operation: AuthorRequestOperation,
      timeoutMs: Schema.Int,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
export class PublicationResponseError
  extends Schema.TaggedError<PublicationResponseError, { readonly brand: unique symbol }>()(
    "PublicationResponseError",
    {
      reason: Schema.TaggedUnion({
        OriginInvalid: { origin: Schema.optionalKey(Schema.String) },
        AcknowledgementInvalid: { origin: Schema.String, failure: RequestCause },
        TransportFailed: { origin: Schema.String, failure: Schema.Defect() },
        DestinationInvalid: {
          origin: Schema.String,
          issues: Schema.Array(
            Schema.Literals([
              "malformed-url",
              "different-origin",
              "scheme",
              "credentials",
              "fragment",
            ]),
          ),
        },
        ResponseFailure: RegistryResponseFailure.fields,
      }),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export class RegistryTransportError
  extends Schema.TaggedError<RegistryTransportError, { readonly brand: unique symbol }>()(
    "RegistryTransportError",
    {
      cause: Schema.ErrorInstance(),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  override get message(): string {
    return this.cause.message;
  }
}

export class LibraryApiRejected
  extends Schema.TaggedError<LibraryApiRejected, { readonly brand: unique symbol }>()(
    "Library.LibraryApiRejected",
    {
      status: Schema.Int,
      reason: Schema.optionalKey(Schema.String),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  override get message(): string {
    return registryRequestFailure(this).message;
  }
}

export class LibraryApiInvalidResponse
  extends Schema.TaggedError<LibraryApiInvalidResponse, { readonly brand: unique symbol }>()(
    "Library.LibraryApiInvalidResponse",
    {
      operation: Schema.String,
      failure: Schema.optionalKey(RequestCause),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  override get message(): string {
    return registryRequestFailure(this).message;
  }
}

export class LibraryManifestTooNew
  extends Schema.TaggedError<LibraryManifestTooNew, { readonly brand: unique symbol }>()(
    "Library.LibraryManifestTooNew",
    {
      observed: Schema.String,
      supported: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  override get message(): string {
    return registryRequestFailure(this).message;
  }
}

export class LibraryApiInvalidRequest
  extends Schema.TaggedError<LibraryApiInvalidRequest, { readonly brand: unique symbol }>()(
    "Library.LibraryApiInvalidRequest",
    {
      failure: Schema.optionalKey(RequestCause),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  override get message(): string {
    return registryRequestFailure(this).message;
  }
}

export const RegistryRequestFailure = Schema.Union([
  AuthorListResponseError,
  AuthorSkitNotFound,
  AuthorDeleteResponseError,
  AuthorListPaginationError,
  AuthorRequestFailed,
  AuthorRequestTimedOut,
  PublicationResponseError,
  RegistryTransportError,
  LibraryApiRejected,
  LibraryApiInvalidResponse,
  LibraryManifestTooNew,
  LibraryApiInvalidRequest,
]);
export type RegistryRequestFailure = typeof RegistryRequestFailure.Type;

const requestDiagnostics = (failure: unknown): readonly Block[] =>
  failure === undefined
    ? []
    : Schema.is(SchemaFailure)(failure)
      ? [
          Block.List({
            items: schemaFailureMessages(failure).map((message) => ({ text: [message] })),
          }),
        ]
      : [Block.Note({ text: [errorMessage(failure)] })];

const authorRequestName = (operation: typeof AuthorRequestOperation.Type) =>
  ({
    current: "Read the current SKIT",
    revision: "Read a revision",
    ancestors: "Read revision history",
    post: "Upload a revision",
    move: "Move the current revision",
    create: "Create a SKIT",
  })[operation];

/** Request owners keep their facts; this formatter owns every explanation and action. */
export const registryRequestFailure = (failure: RegistryRequestFailure) =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      RegistryTransportError: ({ cause }) =>
        describeFailure({
          summary: ["Registry transport failed"],
          details: [Block.Note({ text: [errorMessage(cause)] })],
          next: ["Check the network connection and the Registry origin, then retry."],
        }),
      AuthorListResponseError: (failure) =>
        describeFailure({
          summary: ["The author inventory request failed"],
          details: registryResponseDetails(failure),
          next: ["Check the Registry's reason, then retry."],
        }),
      AuthorDeleteResponseError: (failure) =>
        describeFailure({
          summary: [
            failure.status !== undefined && failure.status >= 400 && failure.status < 500
              ? "The Registry refused private SKIT deletion"
              : "Private SKIT deletion could not be confirmed",
          ],
          details: registryResponseDetails(failure),
          next:
            failure.status !== undefined && failure.status >= 400 && failure.status < 500
              ? ["Check the Registry response, then retry."]
              : ["Check whether the SKIT still exists at the Registry before retrying deletion."],
        }),
      AuthorSkitNotFound: () =>
        describeFailure({
          summary: ["The private SKIT was not found or is not owned by you"],
          next: ["Check the destination, and that you are signed in as its owner, then retry."],
        }),
      AuthorListPaginationError: ({ origin }) =>
        describeFailure({
          summary: [
            "Registry ",
            { code: origin },
            " returned non-progressing or excessive inventory pages",
          ],
          next: ["Retry; if it persists, report the Registry's inventory to its operator."],
        }),
      PublicationResponseError: ({ reason }) =>
        Match.value(reason).pipe(
          Match.tagsExhaustive({
            OriginInvalid: ({ origin }) =>
              describeFailure({
                summary: ["The publication Registry origin is invalid"],
                details:
                  origin === undefined
                    ? []
                    : [Block.Fields({ rows: [{ label: "Registry", value: [{ code: origin }] }] })],
                next: [
                  "Use HTTPS, or a local development Registry at ",
                  { code: "http://localhost" },
                  " or ",
                  { code: "http://127.0.0.1" },
                  ".",
                ],
              }),
            AcknowledgementInvalid: ({ origin, failure }) =>
              describeFailure({
                summary: ["Publication could not be confirmed"],
                details: [
                  Block.Fields({ rows: [{ label: "Registry", value: [{ code: origin }] }] }),
                  ...requestDiagnostics(failure),
                ],
                next: [
                  "The release may have been published. Check the Registry's releases before retrying.",
                ],
              }),
            TransportFailed: ({ origin, failure }) =>
              describeFailure({
                summary: ["Publication could not be confirmed"],
                details: [
                  Block.Fields({ rows: [{ label: "Registry", value: [{ code: origin }] }] }),
                  ...requestDiagnostics(failure),
                ],
                next: [
                  "The release may have been published. Check the Registry's releases before retrying.",
                ],
              }),
            DestinationInvalid: ({ origin, issues }) =>
              describeFailure({
                summary: ["Registry discovery returned an invalid publication destination"],
                details: [
                  Block.Fields({ rows: [{ label: "Registry", value: [{ code: origin }] }] }),
                  Block.List({
                    items: issues.map((issue) => ({
                      text: [
                        {
                          "malformed-url": "The destination is not a valid URL.",
                          "different-origin": "The destination uses a different Registry origin.",
                          scheme: "The destination does not use HTTP or HTTPS.",
                          credentials: "The destination contains URL credentials.",
                          fragment: "The destination contains a URL fragment.",
                        }[issue],
                      ],
                    })),
                  }),
                ],
                next: [
                  "Ask the Registry operator to correct its publication destination, then retry.",
                ],
              }),
            ResponseFailure: (failure) =>
              describeFailure({
                summary: [
                  failure.status !== undefined && failure.status >= 400 && failure.status < 500
                    ? "The Registry refused publication"
                    : "Publication could not be confirmed",
                ],
                details: registryResponseDetails(failure),
                next:
                  failure.status !== undefined && failure.status >= 400 && failure.status < 500
                    ? ["Check the Registry response before trying publication again."]
                    : [
                        "The release may have been published. Check the Registry's releases before retrying.",
                      ],
              }),
          }),
        ),
      AuthorRequestFailed: (failure) =>
        describeFailure({
          summary: ["The author Registry request failed"],
          details: [
            Block.Fields({
              rows: [{ label: "Operation", value: [authorRequestName(failure.operation)] }],
            }),
            ...registryResponseDetails(failure),
          ],
          next:
            (failure.operation === "post" ||
              failure.operation === "move" ||
              failure.operation === "create") &&
            !(failure.status !== undefined && failure.status >= 400 && failure.status < 500)
              ? [
                  "The request may have reached the Registry. Check its current state before retrying.",
                ]
              : ["Check the Registry response, then sync again."],
        }),
      AuthorRequestTimedOut: ({ origin, operation, timeoutMs }) =>
        describeFailure({
          summary: ["The author Registry request timed out"],
          details: [
            Block.Fields({
              rows: [
                { label: "Registry", value: [{ code: origin }] },
                { label: "Operation", value: [authorRequestName(operation)] },
                { label: "Timeout", value: [`${timeoutMs / 1000} seconds`] },
              ],
            }),
          ],
          next:
            operation === "post" || operation === "move" || operation === "create"
              ? [
                  "The request may have reached the Registry. Check its current state before retrying.",
                ]
              : ["Check the Registry connection, then retry."],
        }),
      "Library.LibraryApiRejected": ({ status, reason }) =>
        describeFailure({
          summary: ["The Registry rejected the Library request"],
          details: [
            Block.Fields({
              rows: [
                { label: "HTTP status", value: [String(status)] },
                ...(reason === undefined
                  ? []
                  : [{ label: "Registry code", value: [{ code: reason }] }]),
              ],
            }),
          ],
          next: [
            reason === undefined
              ? "Check the Registry response, then run "
              : "Address the Registry's reported error, then run ",
            { code: "skit sync" },
            " again.",
          ],
        }),
      "Library.LibraryApiInvalidResponse": ({ operation, failure }) =>
        describeFailure({
          summary: ["The Registry response is invalid"],
          details: [
            Block.Fields({ rows: [{ label: "Request", value: [operation] }] }),
            ...requestDiagnostics(failure),
          ],
          next: ["Check that the Registry runs a compatible SKIT server, then retry."],
        }),
      "Library.LibraryManifestTooNew": ({ observed, supported }) =>
        describeFailure({
          summary: ["The Registry's Library was written by a newer SKIT"],
          details: [
            Block.Fields({
              rows: [
                { label: "Received format", value: [{ code: observed }] },
                { label: "Supported format", value: [{ code: supported }] },
              ],
            }),
          ],
          next: ["Upgrade SKIT, then run ", { code: "skit sync" }, " again."],
        }),
      "Library.LibraryApiInvalidRequest": ({ failure }) =>
        describeFailure({
          summary: ["The Library could not be encoded as a Registry request"],
          details: requestDiagnostics(failure),
          next: [
            "Run ",
            { code: "skit doctor" },
            " to inspect the Library, then run ",
            { code: "skit sync" },
            " again.",
          ],
        }),
    }),
  );
