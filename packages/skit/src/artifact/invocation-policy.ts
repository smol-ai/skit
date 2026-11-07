import { Schema } from "effect";

/** Portable invocation intent; each Harness translates it into its native metadata. */
export const InvocationPolicy = Schema.Literals(["explicit", "implicit", "host-policy"]);
export type InvocationPolicy = typeof InvocationPolicy.Type;
