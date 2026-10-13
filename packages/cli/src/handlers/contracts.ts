import { Schema } from "effect";
import {
  outputContracts,
  type ContractData,
  type ContractKey,
  type SingleContractKey,
} from "../commands/output-contracts.js";
import type { CommandResult } from "../commands/types.js";

export function result<K extends ContractKey>(
  contract: K & SingleContractKey<K>,
  data: ContractData<NoInfer<K>>,
  exitCode?: number,
): CommandResult<K> {
  const { id, schema } = outputContracts[contract];
  const encodedData = Schema.encodeUnknownSync(schema)(data);
  return { contract, schema: id, data, encodedData, exitCode };
}
