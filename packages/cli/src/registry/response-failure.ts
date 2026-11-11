import { Schema } from "effect";
import { errorMessage } from "@smolai/skit-core/shared";
import { Block } from "../terminal/blocks.js";

/** Facts retained at the Registry response boundary, including its original live failure. */
export const RegistryResponseFailure = Schema.Struct({
  origin: Schema.String,
  status: Schema.optionalKey(Schema.Int),
  registryCode: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  failure: Schema.Defect(),
});

export const registryResponseDetails = ({
  origin,
  status,
  registryCode,
  body,
  failure,
}: typeof RegistryResponseFailure.Type): readonly Block[] => [
  Block.Fields({
    rows: [
      { label: "Registry", value: [{ code: origin }] },
      ...(status === undefined ? [] : [{ label: "HTTP status", value: [String(status)] }]),
      ...(registryCode === undefined
        ? []
        : [{ label: "Registry code", value: [{ code: registryCode }] }]),
    ],
  }),
  ...(body
    ? [Block.Verbatim({ text: body })]
    : status === undefined && registryCode === undefined
      ? [Block.Note({ text: [errorMessage(failure)] })]
      : []),
];
