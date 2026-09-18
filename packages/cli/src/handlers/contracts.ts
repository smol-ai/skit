import { Schema } from "effect";
import { type AnyOutputContract, type ContractDataOf } from "../commands/output-contracts.js";
import type { CommandResult } from "../commands/types.js";

export function result<C extends AnyOutputContract>(
  _command: string,
  contract: C,
  data: ContractDataOf<NoInfer<C>>,
  exitCode?: number,
): CommandResult & {
  readonly schema: C["id"];
  readonly data: ContractDataOf<C>;
  readonly encodedData: C["schema"]["Encoded"];
} {
  const encodedData = Schema.encodeUnknownSync(contract.schema)(data);
  return { schema: contract.id, data, encodedData, exitCode };
}
