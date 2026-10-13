import type { ContractData, ContractKey, outputContracts } from "./output-contracts.js";

export interface ContractResult<K extends ContractKey> {
  /** Selects the presenter; JSON output carries `schema` instead. */
  contract: K;
  schema: (typeof outputContracts)[K]["id"];
  /** Semantic Type-side data consumed by presenters and in-process callers. */
  data: ContractData<K>;
  /** Schema-encoded wire data consumed by JSON output. */
  encodedData: (typeof outputContracts)[K]["schema"]["Encoded"];
  /** Terminal presentation only; excluded from encoded JSON output. */
  detail?: "summary" | "full";
  exitCode?: number;
}

export type CommandResult = { [K in ContractKey]: ContractResult<K> }[ContractKey];

export interface CommandFailure {
  code: string;
  exitCode: number;
  message: string;
  remediation: string;
}
