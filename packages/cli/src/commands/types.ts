import type { ContractId } from "./output-contracts.js";

export interface CommandResult {
  schema: ContractId;
  /** Semantic Type-side data consumed by presenters and in-process callers. */
  data: unknown;
  /** Schema-encoded wire data consumed by JSON output. */
  encodedData: unknown;
  exitCode?: number;
}

export interface CommandFailure {
  code: string;
  exitCode: number;
  message: string;
  remediation: string;
}
