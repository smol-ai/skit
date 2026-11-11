import {
  FailureTypeId,
  SchemaFailure,
  errorMessage,
  type SkitFailure,
} from "@smolai/skit-core/shared";
import { Match, Schema } from "effect";
import { Block } from "../terminal/blocks.js";
import { describeFailure } from "../terminal/failure.js";
import { schemaFailureMessages } from "../platform/schema-failure.js";

const FeedbackCause = Schema.Union([SchemaFailure, Schema.Defect()]).pipe(
  Schema.decodeTo(Schema.Unknown),
);
export class FeedbackInputInvalid
  extends Schema.TaggedError<FeedbackInputInvalid, { readonly brand: unique symbol }>()(
    "FeedbackInputInvalid",
    {
      reason: Schema.TaggedUnion({
        ConflictingMessages: {},
        InvalidData: { failure: SchemaFailure },
      }),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  override get message(): string {
    return feedbackFailure(this).message;
  }
}
export class FeedbackNotSent
  extends Schema.TaggedError<FeedbackNotSent, { readonly brand: unique symbol }>()(
    "FeedbackNotSent",
    {
      reason: Schema.TaggedUnion({
        RequestInvalid: { failure: SchemaFailure },
        Rejected: {
          origin: Schema.String,
          status: Schema.optionalKey(Schema.Int),
          code: Schema.optionalKey(Schema.String),
        },
      }),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  override get message(): string {
    return feedbackFailure(this).message;
  }
}
export class FeedbackUnconfirmed
  extends Schema.TaggedError<FeedbackUnconfirmed, { readonly brand: unique symbol }>()(
    "FeedbackUnconfirmed",
    {
      origin: Schema.String,
      reason: Schema.TaggedUnion({
        TransportFailed: { failure: Schema.Defect() },
        ResponseInvalid: { failure: FeedbackCause },
        TimedOut: { timeoutMs: Schema.Int },
        ServerError: {
          status: Schema.optionalKey(Schema.Int),
          code: Schema.optionalKey(Schema.String),
        },
      }),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  override get message(): string {
    return feedbackFailure(this).message;
  }
}
export const FeedbackFailure = Schema.Union([
  FeedbackInputInvalid,
  FeedbackNotSent,
  FeedbackUnconfirmed,
]);
export type FeedbackFailure = typeof FeedbackFailure.Type;

const diagnostics = (failure: unknown) =>
  Schema.is(SchemaFailure)(failure)
    ? Block.List({ items: schemaFailureMessages(failure).map((message) => ({ text: [message] })) })
    : Block.Note({ text: [errorMessage(failure)] });

export const feedbackFailure = (failure: FeedbackFailure) =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      FeedbackInputInvalid: ({ reason }) =>
        describeFailure({
          summary: ["Feedback input is invalid"],
          details: Match.value(reason).pipe(
            Match.tagsExhaustive({
              ConflictingMessages: () => [
                Block.Note({
                  text: [
                    "Feedback was given both as an argument and with ",
                    { code: "--message" },
                    ".",
                  ],
                }),
              ],
              InvalidData: ({ failure }) => [diagnostics(failure)],
            }),
          ),
          next: [
            "Pass one message, either as an argument or with ",
            { code: "--message" },
            ": ",
            { code: 'skit feedback send "what slowed you down"' },
            ".",
          ],
        }),
      FeedbackNotSent: ({ reason }) =>
        describeFailure({
          summary: ["Feedback was not sent"],
          details: Match.value(reason).pipe(
            Match.tagsExhaustive({
              RequestInvalid: ({ failure }) => [diagnostics(failure)],
              Rejected: ({ origin, status, code }) => [
                Block.Fields({
                  rows: [
                    { label: "Registry", value: [{ code: origin }] },
                    ...(status === undefined
                      ? []
                      : [{ label: "HTTP status", value: [String(status)] }]),
                    ...(code === undefined ? [] : [{ label: "Registry code", value: [{ code }] }]),
                  ],
                }),
              ],
            }),
          ),
          next: [
            "Correct the reported issue, then retry the same command; feedback is not saved for later.",
          ],
        }),
      FeedbackUnconfirmed: ({ origin, reason }) =>
        describeFailure({
          summary: ["Feedback delivery could not be confirmed"],
          details: [
            Block.Fields({ rows: [{ label: "Registry", value: [{ code: origin }] }] }),
            ...Match.value(reason).pipe(
              Match.tagsExhaustive({
                TransportFailed: ({ failure }) => [diagnostics(failure)],
                ResponseInvalid: ({ failure }) => [diagnostics(failure)],
                TimedOut: ({ timeoutMs }) => [
                  Block.Note({
                    text: [`The Registry did not answer within ${timeoutMs / 1000} seconds.`],
                  }),
                ],
                ServerError: ({ status, code }) => [
                  Block.Fields({
                    rows: [
                      ...(status === undefined
                        ? []
                        : [{ label: "HTTP status", value: [String(status)] }]),
                      ...(code === undefined
                        ? []
                        : [{ label: "Registry code", value: [{ code }] }]),
                    ],
                  }),
                ],
              }),
            ),
          ],
          next: ["The report may have arrived. Do not send it again; carry on with the task."],
        }),
    }),
  );
