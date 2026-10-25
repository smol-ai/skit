import { Context } from "effect";
import type { AnyOutputContract } from "./output-contracts.js";

/** The side effects a command may have, published so callers can decide whether to run it. */
export type CommandCapability =
  | "filesystem.read"
  | "filesystem.write"
  | "network.read"
  | "network.write"
  | "process.execute"
  | "browser.open";

export interface CommandMetadataShape {
  readonly stability?: "stable" | "experimental";
  readonly effects?: {
    readonly capabilities: readonly CommandCapability[];
    readonly subprocesses?: readonly string[];
  };
  readonly outputSchemas: readonly AnyOutputContract[];
  readonly exitCodes: readonly number[];
  readonly interactive: boolean;
}

/** Git commands Source acquisition runs when it retains or restores a Git or GitHub Source. */
export const sourceAcquisitionSubprocesses = [
  "git clone --filter=blob:none --no-checkout",
  "git fetch --filter=blob:none",
  "git checkout --detach",
  "git rev-parse",
  "git ls-files",
  "git check-ignore",
] as const;

/** Metadata that belongs to SKIT's public contract rather than Effect's CLI grammar. */
export const CommandMetadata = Context.Service<never, CommandMetadataShape>(
  "skit/cli/CommandMetadata",
);
