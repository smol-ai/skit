import { RequestDecoding } from "@smolai/skit-core/universal/api";
import { Effect } from "effect";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { invalidRequestResponse } from "./errors.js";

export { RequestDecoding };

// Effect v4's schema-error transform is the supported seam for preserving a
// public API's decoding-error envelope.
export const requestDecodingLayer = HttpApiMiddleware.layerSchemaErrorTransform(
  RequestDecoding,
  () => Effect.fail(invalidRequestResponse),
);
