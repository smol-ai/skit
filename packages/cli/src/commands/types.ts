import type { FailureCode } from "@smolai/skit-core/shared";
import type { Cause } from "effect";
import type { ContractData, ContractKey, outputContracts } from "./output-contracts.js";
import type { FailureDescription } from "../terminal/failure.js";

/** One variant per contract, so `contract` and `data` stay paired even when K is a union. */
export type CommandResult<K extends ContractKey = ContractKey> = {
  [P in K]: {
    /** Selects the presenter; JSON output carries `schema` instead. */
    contract: P;
    schema: (typeof outputContracts)[P]["id"];
    /** Semantic Type-side data consumed by presenters and in-process callers. */
    data: ContractData<P>;
    /** Schema-encoded wire data consumed by JSON output. */
    encodedData: (typeof outputContracts)[P]["schema"]["Encoded"];
    /** Terminal presentation only; excluded from encoded JSON output. */
    detail?: "summary" | "full";
  };
}[K];

export interface CommandFailure extends FailureDescription {
  code: FailureCode;
  /** The original cause is encoded only by the JSON output boundary. */
  cause: Cause.Cause<unknown>;
}
