import { Schema } from "effect";
import { InvocationPolicy } from "../artifact/invocation-policy.js";
export const LibraryInvocationOption = Schema.Union([InvocationPolicy, Schema.Literal("declared")]);
export type LibraryInvocationOption = typeof LibraryInvocationOption.Type;
