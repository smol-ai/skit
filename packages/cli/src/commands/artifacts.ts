import { Effect, JsonSchema, Schema } from "effect";
import { outputContracts } from "./output-contracts.js";
import type { AnyOutputContract } from "./output-contracts.js";
import { commandDocuments } from "./manifest.js";
import { skitCommand } from "./tree.js";

function contractJsonSchema(contract: AnyOutputContract): JsonSchema.JsonSchema {
  const document = JsonSchema.toDocumentDraft07(
    Schema.toJsonSchemaDocument(contract.schema, { additionalProperties: true }),
  );
  return Object.keys(document.definitions).length
    ? { ...document.schema, definitions: document.definitions }
    : document.schema;
}

export const commandContractArtifacts = Effect.fn("CLI.commandContractArtifacts")(function* () {
  const documents = yield* commandDocuments(skitCommand);
  const definitions = documents.map((command) => ({
    path: command.path,
    stability: command.stability,
    summary: command.summary,
    effects: command.effects,
    outputSchemas: command.outputSchemas.slice(0, -2),
    exitCodes: command.successExitCodes,
    interactive: command.interactive,
    examples: command.examples,
    positionals: command.positionals,
    flags: command.documentedFlags,
  }));
  const artifacts: Record<string, string> = {
    "command-manifest.json": `${JSON.stringify({ commands: definitions }, null, 2)}\n`,
  };
  const exposedOutputSchemas = new Set(documents.flatMap((command) => command.outputSchemas));
  for (const contract of Object.values(outputContracts)) {
    if (!exposedOutputSchemas.has(contract.id)) continue;
    artifacts[`${contract.id}.json`] = `${JSON.stringify(
      {
        $id: contract.id,
        ...contractJsonSchema(contract),
        $schema: "http://json-schema.org/draft-07/schema#",
      },
      null,
      2,
    )}\n`;
  }
  return Object.fromEntries(
    Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right)),
  );
});
