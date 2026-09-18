import { Context } from "effect";
import type { AnyOutputContract } from "./output-contracts.js";

export interface CommandMetadataShape {
  readonly stability?: "stable" | "experimental";
  readonly effects?: {
    readonly capabilities: readonly string[];
    readonly subprocesses?: readonly string[];
  };
  readonly outputSchemas: readonly AnyOutputContract[];
  readonly exitCodes: readonly number[];
  readonly interactive: boolean;
}

/** Metadata that belongs to SKIT's public contract rather than Effect's CLI grammar. */
export const CommandMetadata = Context.Service<never, CommandMetadataShape>(
  "skit/cli/CommandMetadata",
);
