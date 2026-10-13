import { Schema } from "effect";
import {
  outputContracts,
  type ContractData,
  type ContractKey,
} from "../commands/output-contracts.js";
import type { ContractResult } from "../commands/types.js";

export function result<K extends ContractKey>(
  contract: K,
  data: ContractData<NoInfer<K>>,
  exitCode?: number,
): ContractResult<K> {
  const { id, schema } = outputContracts[contract];
  const encodedData = Schema.encodeUnknownSync(schema)(data);
  return { contract, schema: id, data, encodedData, exitCode };
}
