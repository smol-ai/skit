import { Schema } from "effect";
import type {
  outputContracts,
  ContractData,
  ContractKey,
  SingleContractKey,
} from "./output-contracts.js";
import type { CommandResult } from "./types.js";

export function encodeResult<K extends ContractKey>(
  contract: K & SingleContractKey<K>,
  definition: (typeof outputContracts)[NoInfer<K>],
  data: ContractData<NoInfer<K>>,
): CommandResult<K> {
  const { id, schema } = definition;
  const encodedData = Schema.encodeUnknownSync(schema)(data);
  return { contract, schema: id, data, encodedData };
}
