import { Schema } from "effect";
import { InvocationPolicy } from "../artifact/invocation-policy.js";
import { AuthoredInvocationHarness } from "../harnesses/invocation-metadata.js";

const NativePolicy = Schema.optional(Schema.Literals(["explicit", "implicit"]));
export const InvocationConformanceIssue = Schema.Struct({
  skill: Schema.String,
  harness: AuthoredInvocationHarness,
  path: Schema.String,
  field: Schema.String,
  policy: InvocationPolicy,
  expected: NativePolicy,
  actual: NativePolicy,
});
export type InvocationConformanceIssue = typeof InvocationConformanceIssue.Type;
