import { encodeResult } from "./encode-result.js";
import {
  outputContracts,
  type ContractData,
  type ContractKey,
  type SingleContractKey,
} from "./output-contracts.js";
import type { CommandResult } from "./types.js";

export function result<K extends ContractKey>(
  contract: K & SingleContractKey<K>,
  data: ContractData<NoInfer<K>>,
): CommandResult<K> {
  return encodeResult(contract, outputContracts[contract], data);
}
