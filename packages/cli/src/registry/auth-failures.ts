import { PlatformErrorSchema } from "@smolai/skit-core/platform";
import {
  FailureTypeId,
  SchemaFailure,
  errorMessage,
  type SkitFailure,
} from "@smolai/skit-core/shared";
import { Match, Schema, SchemaIssue } from "effect";
import { isPlatformError, type PlatformError } from "effect/PlatformError";
import { schemaFailureMessages } from "../platform/schema-failure.js";
import { Block, type Inline } from "../terminal/blocks.js";
import { describeFailure, type FailureDescription } from "../terminal/failure.js";
import { RegistryTransportError } from "./request-failures.js";

export const AuthOperation = Schema.Literals([
  "discovery",
  "credential-check",
  "sign-in",
  "device-authorization",
  "device-token",
  "credential-create",
  "credential-revoke",
]);
export type AuthOperation = typeof AuthOperation.Type;

const RequestCause = Schema.toCodecJson(
  Schema.Union([RegistryTransportError, SchemaFailure, Schema.Defect()]),
).pipe(Schema.decodeTo(Schema.Unknown));
export const AuthCleanupFailure = Schema.TaggedUnion({
  RequestFailed: { failure: RequestCause },
  ResponseRejected: {
    status: Schema.Int,
    body: Schema.optionalKey(Schema.String),
    failure: Schema.optionalKey(RequestCause),
  },
});
export type AuthCleanupFailure = typeof AuthCleanupFailure.Type;
export const CredentialRotationWarning = Schema.TaggedStruct("PreviousCredentialNotRevoked", {
  tokenId: Schema.String,
  tokenPrefix: Schema.String,
  cleanup: AuthCleanupFailure,
});

// Native causes remain untouched in-process. Only the JSON boundary projects their facts.
const AuthCause: Schema.Codec<unknown, unknown> = Schema.suspend(() =>
  Schema.Union([AuthFailure, PlatformErrorSchema, SchemaFailure, Schema.Defect()]).pipe(
    Schema.decodeTo(Schema.Unknown),
  ),
);
const ResponseFacts = {
  status: Schema.optionalKey(Schema.Int),
  registryCode: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(RequestCause),
};
export const SignInFailureReason = Schema.TaggedUnion({
  RequestFailed: { operation: AuthOperation, ...ResponseFacts },
  ResponseInvalid: {
    operation: AuthOperation,
    status: Schema.optionalKey(Schema.Int),
    failure: RequestCause,
  },
  RequestInvalid: { operation: AuthOperation, failure: RequestCause },
  UnsupportedScopes: { scopes: Schema.Array(Schema.String) },
  SessionMissing: {},
  MethodMissing: {},
  CredentialMissing: {},
  DeviceExpiryInvalid: { expiresIn: Schema.Finite, receivedAt: Schema.Finite },
  SessionEndFailed: {
    cleanup: AuthCleanupFailure,
    original: Schema.optionalKey(AuthCause),
    credential: Schema.optionalKey(
      Schema.Struct({
        tokenId: Schema.String,
        tokenPrefix: Schema.String,
        cleanup: AuthCleanupFailure,
      }),
    ),
  },
  StorageCleanupFailed: {
    tokenId: Schema.String,
    tokenPrefix: Schema.String,
    cleanup: AuthCleanupFailure,
    original: AuthCause,
  },
});

export class SignInFailed
  extends Schema.TaggedError<SignInFailed, { readonly brand: unique symbol }>()("SignInFailed", {
    origin: Schema.String,
    reason: SignInFailureReason,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  override get message(): string {
    return authFailure(this).message;
  }
}
export class SignOutRejected
  extends Schema.TaggedError<SignOutRejected, { readonly brand: unique symbol }>()(
    "SignOutRejected",
    {
      origin: Schema.String,
      reason: Schema.TaggedUnion({
        RequestInvalid: { failure: RequestCause },
        ResponseRejected: { ...ResponseFacts, status: Schema.Int },
      }),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  override get message(): string {
    return authFailure(this).message;
  }
}
export class SignInRejected
  extends Schema.TaggedError<SignInRejected, { readonly brand: unique symbol }>()(
    "SignInRejected",
    {
      operation: AuthOperation,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  override get message(): string {
    return authFailure(this).message;
  }
}
export class TooManyAuthAttempts
  extends Schema.TaggedError<TooManyAuthAttempts, { readonly brand: unique symbol }>()(
    "TooManyAuthAttempts",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  override get message(): string {
    return authFailure(this).message;
  }
}
export class CredentialsUnusable
  extends Schema.TaggedError<CredentialsUnusable, { readonly brand: unique symbol }>()(
    "CredentialsUnusable",
    {
      path: Schema.String,
      reason: Schema.Literals(["unreadable", "invalid"]),
      failure: Schema.optionalKey(
        Schema.Union([PlatformErrorSchema, RequestCause]).pipe(Schema.decodeTo(Schema.Unknown)),
      ),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  override get message(): string {
    return authFailure(this).message;
  }
}
export const AuthFailure = Schema.Union([
  SignInFailed,
  SignOutRejected,
  SignInRejected,
  TooManyAuthAttempts,
  CredentialsUnusable,
]);
export type AuthFailure = typeof AuthFailure.Type;

const operationNames = {
  discovery: "Registry discovery",
  "credential-check": "Credential check",
  "sign-in": "Sign in",
  "device-authorization": "Device authorization",
  "device-token": "Device approval",
  "credential-create": "Credential creation",
  "credential-revoke": "Credential cleanup",
} satisfies Record<AuthOperation, string>;
const login: readonly Inline[] = [
  "Check the Registry origin and requested scopes, then run ",
  { code: "skit auth login" },
  " again.",
];
// Auth responses can contain credentials. Name invalid fields without echoing their input values.
const authSchemaIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    ({
      InvalidType: "Value has the wrong type",
      InvalidValue: "Invalid value",
      MissingKey: "Missing required field",
      UnexpectedKey: "Unexpected field",
      Forbidden: "Value is forbidden here",
      OneOf: "Expected exactly one matching type",
    })[issue._tag],
  checkHook: () => "Value does not satisfy its required format",
});
const fileFailureNames = {
  AlreadyExists: "A file or folder already exists",
  BadArgument: "The file operation has invalid arguments",
  BadResource: "The file is no longer available",
  Busy: "The file or folder is busy",
  InvalidData: "The file contains invalid data",
  NotFound: "The file or folder was not found",
  PermissionDenied: "File access was denied",
  TimedOut: "The file operation timed out",
  UnexpectedEof: "The file ended unexpectedly",
  Unknown: "The file operation failed",
  WouldBlock: "The file operation could not proceed",
  WriteZero: "The file could not be written",
} satisfies Record<PlatformError["reason"]["_tag"], string>;
const diagnostic = (failure: unknown): readonly Block[] =>
  Schema.is(SchemaFailure)(failure)
    ? (Schema.isSchemaError(failure) || SchemaIssue.isIssue(failure)
        ? authSchemaIssue(Schema.isSchemaError(failure) ? failure.issue : failure).issues.map(
            (issue) =>
              `${issue.message}${issue.path?.length ? ` at ${issue.path.map((key) => `[${typeof key === "string" ? JSON.stringify(key) : String(key)}]`).join("")}` : ""}`,
          )
        : schemaFailureMessages(failure)
      ).map((text) => Block.Note({ text: [text] }))
    : isPlatformError(failure)
      ? [
          Block.Note({ text: [fileFailureNames[failure.reason._tag]] }),
          Block.Fields({
            rows:
              failure.reason._tag !== "BadArgument" &&
              typeof failure.reason.pathOrDescriptor === "string"
                ? [{ label: "Path", value: [{ path: failure.reason.pathOrDescriptor }] }]
                : [],
          }),
        ]
      : [Block.Note({ text: [errorMessage(failure)] })];
const responseDetails = (facts: {
  readonly status?: number;
  readonly registryCode?: string;
  readonly failure?: unknown;
}): readonly Block[] => [
  ...(facts.status !== undefined || facts.registryCode !== undefined
    ? [
        Block.Fields({
          rows: [
            ...(facts.status === undefined
              ? []
              : [{ label: "HTTP status", value: [String(facts.status)] }]),
            ...(facts.registryCode === undefined
              ? []
              : [{ label: "Registry code", value: [{ code: facts.registryCode }] }]),
          ],
        }),
      ]
    : []),
  ...(facts.failure === undefined ? [] : diagnostic(facts.failure)),
];
export const authCleanupDetails = (cleanup: AuthCleanupFailure): readonly Block[] =>
  AuthCleanupFailure.match(cleanup, {
    RequestFailed: ({ failure }) => [
      Block.Note({ text: ["No cleanup response was received."] }),
      ...diagnostic(failure),
    ],
    ResponseRejected: ({ status, body, failure }) => [
      ...responseDetails({ status, failure }),
      ...(body ? [Block.Verbatim({ text: body })] : []),
    ],
  });
const originalFailure = (failure: unknown): readonly Block[] => [
  Block.Group({
    title: "Original failure",
    children: Schema.is(AuthFailure)(failure)
      ? authFailure(failure).explanation
      : diagnostic(failure),
  }),
];
const originalAction = (failure: unknown, fallback: readonly Inline[]): readonly Inline[] =>
  Schema.is(AuthFailure)(failure) ? authFailure(failure).next : fallback;

const signInFailure = ({ origin, reason }: SignInFailed): FailureDescription => {
  const registry = Block.Fields({ rows: [{ label: "Registry", value: [{ code: origin }] }] });
  const describe = (
    summary: readonly Inline[],
    details: readonly Block[] = [],
    next: readonly Inline[] = login,
  ) => describeFailure({ summary, details: [registry, ...details], next });
  return SignInFailureReason.match(reason, {
    RequestFailed: (facts) =>
      describe(
        [
          facts.operation === "credential-create" &&
          (facts.status === undefined || facts.status >= 500)
            ? "Credential creation could not be confirmed"
            : `${operationNames[facts.operation]} failed`,
        ],
        responseDetails(facts),
        facts.operation === "credential-create" &&
          (facts.status === undefined || facts.status >= 500)
          ? [
              "A credential may have been created. Check and revoke unused credentials at the Registry before signing in again.",
            ]
          : login,
      ),
    ResponseInvalid: (facts) =>
      describe(
        [
          facts.operation === "credential-create"
            ? "Credential creation could not be confirmed"
            : `${operationNames[facts.operation]} returned invalid data`,
        ],
        responseDetails(facts),
        facts.operation === "credential-create"
          ? [
              "The Registry returned an invalid credential response. Check and revoke unused credentials at the Registry before signing in again.",
            ]
          : login,
      ),
    RequestInvalid: ({ operation, failure }) =>
      describe([`${operationNames[operation]} request is invalid`], diagnostic(failure)),
    UnsupportedScopes: ({ scopes }) =>
      describe(
        ["Registry does not support the requested scopes"],
        [Block.List({ items: scopes.map((scope) => ({ text: [{ code: scope }] })) })],
      ),
    SessionMissing: () => describe(["Sign in did not establish a session"]),
    MethodMissing: () => describe(["No sign-in method was given"]),
    CredentialMissing: () => describe(["Credential creation returned no credential"]),
    DeviceExpiryInvalid: ({ expiresIn }) =>
      describe(
        ["Device authorization expiry is out of range"],
        [Block.Fields({ rows: [{ label: "Lifetime in seconds", value: [String(expiresIn)] }] })],
      ),
    SessionEndFailed: ({ cleanup, original, credential }) =>
      describe(
        [credential ? "Sign out and credential cleanup failed" : "Sign out failed"],
        [
          Block.Group({ title: "Session cleanup", children: authCleanupDetails(cleanup) }),
          Block.Note({
            text: ["The CLI credential was not saved. The temporary session may still be live."],
          }),
          ...(credential
            ? [
                Block.Group({
                  title: "Credential cleanup",
                  children: [
                    Block.Fields({
                      rows: [
                        {
                          label: "Credential",
                          value: [
                            { code: credential.tokenId },
                            " (",
                            { code: credential.tokenPrefix },
                            ")",
                          ],
                        },
                      ],
                    }),
                    ...authCleanupDetails(credential.cleanup),
                  ],
                }),
                Block.Note({ text: ["The credential may still be live."] }),
              ]
            : []),
          ...(original === undefined ? [] : originalFailure(original)),
        ],
        [
          "End the temporary session at the Registry",
          ...(credential ? [" and revoke the credential shown above"] : []),
          ". ",
          ...originalAction(original, ["Then sign in again."]),
        ],
      ),
    StorageCleanupFailed: ({ tokenId, tokenPrefix, cleanup, original }) =>
      describe(
        ["Credential storage and cleanup failed"],
        [
          Block.Fields({
            rows: [
              { label: "Credential", value: [{ code: tokenId }, " (", { code: tokenPrefix }, ")"] },
            ],
          }),
          ...authCleanupDetails(cleanup),
          Block.Note({ text: ["The credential may still be live."] }),
          ...originalFailure(original),
        ],
        [
          "Revoke the credential shown above at the Registry. ",
          ...originalAction(original, ["Fix the storage failure, then sign in again."]),
        ],
      ),
  });
};

export const authFailure = (failure: AuthFailure): FailureDescription =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      SignInFailed: signInFailure,
      SignOutRejected: ({ origin, reason }) =>
        describeFailure({
          summary: [
            reason._tag === "RequestInvalid" ? "Logout request is invalid" : "Logout failed",
          ],
          details: [
            Block.Fields({ rows: [{ label: "Registry", value: [{ code: origin }] }] }),
            ...(reason._tag === "RequestInvalid"
              ? diagnostic(reason.failure)
              : responseDetails(reason)),
            Block.Note({
              text: [
                "The saved credential was kept because its revocation could not be confirmed.",
              ],
            }),
          ],
          next: [
            "Run ",
            { code: "skit auth logout" },
            " again; if it keeps failing, revoke the credential at the Registry.",
          ],
        }),
      SignInRejected: ({ operation }) =>
        describeFailure({
          // Authentication must not disclose whether an account exists.
          summary: [
            operation === "sign-in"
              ? "Email or password is incorrect"
              : `${operationNames[operation]} was unauthorized`,
          ],
          next:
            operation === "sign-in"
              ? [
                  "Check the email and password, then retry. An account created with GitHub sign-in has no password, so it cannot sign in from the CLI yet.",
                ]
              : ["Run ", { code: "skit auth login" }, " again."],
        }),
      TooManyAuthAttempts: () =>
        describeFailure({
          summary: ["Too many authentication attempts"],
          next: ["Wait one minute, then retry."],
        }),
      CredentialsUnusable: ({ path, reason, failure }) =>
        describeFailure({
          summary: [
            reason === "unreadable"
              ? "Cannot read SKIT authentication configuration at "
              : "SKIT authentication configuration is invalid at ",
            { path },
          ],
          details: failure === undefined ? [] : diagnostic(failure),
          next:
            reason === "unreadable"
              ? ["Check file access at ", { path }, ", then retry."]
              : ["Move ", { path }, " aside, then run ", { code: "skit auth login" }, " again."],
        }),
    }),
  );
