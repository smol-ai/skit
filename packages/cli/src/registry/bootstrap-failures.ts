import {
  FailureTypeId,
  SchemaFailure,
  errorMessage,
  type SkitFailure,
} from "@smolai/skit-core/shared";
import { Match, Schema } from "effect";
import { printParseErrorCode } from "jsonc-parser";
import { Block } from "../terminal/blocks.js";
import { describeFailure, type FailureDescription } from "../terminal/failure.js";
import { schemaFailureMessages } from "../platform/schema-failure.js";

export const SECRET_NAME = "SKIT_BOOTSTRAP_SECRET";
const WranglerTarget = Schema.Struct({
  configPath: Schema.String,
  environment: Schema.optionalKey(Schema.String),
});
export type WranglerTarget = typeof WranglerTarget.Type;
export const wranglerTargetArgs = (target: WranglerTarget) => [
  "--config",
  target.configPath,
  ...(target.environment === undefined ? [] : ["--env", target.environment]),
];
export const removeBootstrapSecretInvocation = (target: WranglerTarget) => ({
  args: ["secret", "delete", SECRET_NAME, ...wranglerTargetArgs(target)],
  input: "y\n",
});
const Diagnostic = Schema.Union([SchemaFailure, Schema.Defect()]).pipe(
  Schema.decodeTo(Schema.Unknown),
);

export class BootstrapOriginInvalid
  extends Schema.TaggedError<BootstrapOriginInvalid, { readonly brand: unique symbol }>()(
    "BootstrapOriginInvalid",
    { origin: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
export class BootstrapConfigInvalid
  extends Schema.TaggedError<BootstrapConfigInvalid, { readonly brand: unique symbol }>()(
    "BootstrapConfigInvalid",
    {
      target: WranglerTarget,
      reason: Schema.TaggedUnion({
        ReadFailed: { failure: Schema.Defect() },
        JsonInvalid: {
          errors: Schema.Array(
            Schema.Struct({ error: Schema.Int, offset: Schema.Int, length: Schema.Int }),
          ),
        },
        InvalidData: { failure: SchemaFailure },
        EnvironmentMissing: { environment: Schema.String },
        OriginMissing: { environment: Schema.optionalKey(Schema.String) },
        EnvironmentRequired: { environments: Schema.Array(Schema.String) },
      }),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
export class BootstrapExternalFailure
  extends Schema.TaggedError<BootstrapExternalFailure, { readonly brand: unique symbol }>()(
    "BootstrapExternalFailure",
    {
      operation: Schema.Literals(["install-secret", "remove-secret", "open-browser", "status"]),
      reason: Schema.TaggedUnion({
        ProcessFailed: { command: Schema.String, exitCode: Schema.Int, output: Schema.String },
        NativeFailure: { failure: Schema.Defect() },
        HttpRejected: {
          origin: Schema.String,
          status: Schema.optionalKey(Schema.Int),
          code: Schema.optionalKey(Schema.String),
        },
        TimedOut: { timeoutMs: Schema.Int },
      }),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
export class BootstrapStatusInvalid
  extends Schema.TaggedError<BootstrapStatusInvalid, { readonly brand: unique symbol }>()(
    "BootstrapStatusInvalid",
    { origin: Schema.String, failure: Diagnostic },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
export class BootstrapTimedOut
  extends Schema.TaggedError<BootstrapTimedOut, { readonly brand: unique symbol }>()(
    "BootstrapTimedOut",
    { origin: Schema.String, timeoutMs: Schema.Int },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
export class BootstrapCleanupFailed
  extends Schema.TaggedError<BootstrapCleanupFailed, { readonly brand: unique symbol }>()(
    "BootstrapCleanupFailed",
    {
      target: WranglerTarget,
      command: Schema.String,
      cleanup: BootstrapExternalFailure,
      original: Schema.optionalKey(
        Schema.Union([BootstrapExternalFailure, BootstrapStatusInvalid, BootstrapTimedOut]),
      ),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
export const BootstrapFailure = Schema.Union([
  BootstrapOriginInvalid,
  BootstrapConfigInvalid,
  BootstrapExternalFailure,
  BootstrapStatusInvalid,
  BootstrapTimedOut,
  BootstrapCleanupFailed,
]);
export type BootstrapFailure = typeof BootstrapFailure.Type;
const diagnostics = (failure: unknown) =>
  Schema.is(SchemaFailure)(failure)
    ? Block.List({ items: schemaFailureMessages(failure).map((text) => ({ text: [text] })) })
    : Block.Note({ text: [errorMessage(failure)] });
const commandArgument = (value: string) =>
  /^[a-zA-Z0-9_./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export const bootstrapFailure = (failure: BootstrapFailure): FailureDescription =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      BootstrapOriginInvalid: ({ origin }) =>
        describeFailure({
          summary: ["Invalid server origin"],
          details: [Block.Fields({ rows: [{ label: "Origin", value: [{ code: origin }] }] })],
          next: ["Pass ", { code: "--url" }, " as the server's full URL."],
        }),
      BootstrapConfigInvalid: ({ target, reason }) =>
        describeFailure({
          summary: ["Wrangler configuration is invalid"],
          details: [
            Block.Fields({
              rows: [{ label: "Configuration", value: [{ path: target.configPath }] }],
            }),
            ...Match.value(reason).pipe(
              Match.tagsExhaustive({
                ReadFailed: ({ failure }) => [diagnostics(failure)],
                JsonInvalid: ({ errors }) => [
                  Block.List({
                    items: errors.map(({ error, offset, length }) => ({
                      text: [
                        `${printParseErrorCode(error)} at offset ${offset} (length ${length})`,
                      ],
                    })),
                  }),
                ],
                InvalidData: ({ failure }) => [diagnostics(failure)],
                EnvironmentMissing: ({ environment }) => [
                  Block.Note({
                    text: ["No Wrangler environment named ", { code: environment }, "."],
                  }),
                ],
                OriginMissing: ({ environment }) => [
                  Block.Note({
                    text: [
                      {
                        code:
                          environment === undefined
                            ? "vars.PUBLIC_APP_ORIGIN"
                            : `env.${environment}.vars.PUBLIC_APP_ORIGIN`,
                      },
                      " is missing.",
                    ],
                  }),
                ],
                EnvironmentRequired: ({ environments }) => [
                  Block.Note({ text: ["Choose which Worker's configuration to use."] }),
                  Block.List({ items: environments.map((name) => ({ text: [{ code: name }] })) }),
                ],
              }),
            ),
          ],
          next: Match.value(reason).pipe(
            Match.tagsExhaustive({
              ReadFailed: () => [
                "Check the configuration path passed with ",
                { code: "--config" },
                " and its permissions, then retry.",
              ],
              JsonInvalid: () => [
                "Correct the reported JSON errors in the configuration, then retry.",
              ],
              InvalidData: () => ["Correct the reported configuration fields, then retry."],
              EnvironmentMissing: () => [
                "Pass an existing environment with ",
                { code: "--env <name>" },
                ".",
              ],
              OriginMissing: () => [
                "Set ",
                { code: "PUBLIC_APP_ORIGIN" },
                " in the selected Worker's variables, or pass ",
                { code: "--url" },
                " explicitly.",
              ],
              EnvironmentRequired: () => [
                "Pass ",
                { code: "--env <name>" },
                ", or ",
                { code: "--url" },
                " to bootstrap the top-level Worker.",
              ],
            }),
          ),
        }),
      BootstrapExternalFailure: ({ operation, reason }) =>
        describeFailure({
          summary: [
            {
              "install-secret": "Bootstrap secret installation failed",
              "remove-secret": "Bootstrap secret removal failed",
              "open-browser": "Could not open the setup page",
              status: "Could not read bootstrap status",
            }[operation],
          ],
          details: Match.value(reason).pipe(
            Match.tagsExhaustive({
              ProcessFailed: ({ command, exitCode, output }) => [
                Block.Fields({
                  rows: [
                    { label: "Command", value: [{ code: command }] },
                    { label: "Exit status", value: [String(exitCode)] },
                  ],
                }),
                ...(output ? [Block.Verbatim({ text: output })] : []),
              ],
              NativeFailure: ({ failure }) => [diagnostics(failure)],
              HttpRejected: ({ origin, status, code }) => [
                Block.Fields({
                  rows: [
                    { label: "Server", value: [{ code: origin }] },
                    ...(status === undefined
                      ? []
                      : [{ label: "HTTP status", value: [String(status)] }]),
                    ...(code === undefined ? [] : [{ label: "Registry code", value: [{ code }] }]),
                  ],
                }),
              ],
              TimedOut: ({ timeoutMs }) => [
                Block.Fields({
                  rows: [{ label: "Timeout", value: [`${timeoutMs / 1000} seconds`] }],
                }),
              ],
            }),
          ),
          next:
            reason._tag === "TimedOut"
              ? ["Check network connectivity and Cloudflare service status before retrying setup."]
              : operation === "open-browser"
                ? [
                    "Check that the system browser can open URLs, then run ",
                    { code: "skit server bootstrap" },
                    " again.",
                  ]
                : operation === "status"
                  ? ["Check the server URL and the reported response, then retry setup."]
                  : ["Check the Wrangler output and credentials, then retry setup."],
        }),
      BootstrapStatusInvalid: ({ origin, failure }) =>
        describeFailure({
          summary: ["Bootstrap status response is invalid"],
          details: [
            Block.Fields({ rows: [{ label: "Server", value: [{ code: origin }] }] }),
            diagnostics(failure),
          ],
          next: ["Check that ", { code: "--url" }, " names a SKIT server, then retry."],
        }),
      BootstrapTimedOut: ({ origin, timeoutMs }) =>
        describeFailure({
          summary: ["Timed out waiting for initial operator setup"],
          details: [
            Block.Fields({
              rows: [
                { label: "Server", value: [{ code: origin }] },
                { label: "Timeout", value: [`${timeoutMs / 1000} seconds`] },
              ],
            }),
          ],
          next: [
            "Finish operator setup in the browser, then run ",
            { code: "skit server bootstrap" },
            " again.",
          ],
        }),
      BootstrapCleanupFailed: ({ target, command, cleanup, original }) => {
        const installUnconfirmed =
          original?._tag === "BootstrapExternalFailure" && original.operation === "install-secret";
        const removal = [command, ...removeBootstrapSecretInvocation(target).args]
          .map(commandArgument)
          .join(" ");
        return describeFailure({
          summary: [
            installUnconfirmed
              ? "Bootstrap secret installation failed; cleanup could not be confirmed"
              : "Bootstrap secret cleanup could not be confirmed",
          ],
          details: [
            ...(original
              ? [
                  Block.Group({
                    title: "Setup failed",
                    children: bootstrapFailure(original).explanation,
                  }),
                ]
              : []),
            Block.Group({
              title: "Cleanup failed",
              children: bootstrapFailure(cleanup).explanation,
            }),
          ],
          next: [
            installUnconfirmed
              ? "If the secret was installed, remove it with "
              : "Remove the bootstrap secret with ",
            { code: removal },
            ".",
          ],
        });
      },
    }),
  );
