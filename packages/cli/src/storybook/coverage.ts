import { authorSyncDetails, authorSyncGaps } from "./author-sync-inventory.js";
import { scenarioSets } from "./scenario-sets.js";
import { authorSyncScenarioInventory } from "./author-sync-journey.js";
import { doctorScenarioInventory } from "./doctor-journey.js";
import { Effect, SchemaAST } from "effect";
import { outputContracts } from "../commands/output-contracts.js";
import type { CommandResult } from "../commands/types.js";
import type { CommandInvocation } from "../commands/invocation.js";
import { commandDocuments } from "../commands/manifest.js";
import { skitCommand } from "../commands/tree.js";
import { OutputStory, outputStories, outputStoryKey } from "./output-stories.js";

/** Fields whose values name the distinct states a command can report. */
const STATE_FIELDS = ["status", "event", "action"] as const;
type StateField = (typeof STATE_FIELDS)[number];

export interface ContractCoverage {
  readonly contract: string;
  /** The field that names the contract's states; absent when the contract has a single state. */
  readonly field?: StateField;
  readonly states: ReadonlyArray<{ readonly state: string; readonly stories: readonly string[] }>;
  /** Stories for the contract, whatever state they show. */
  readonly stories: readonly string[];
  readonly variants?: readonly {
    readonly state: string;
    readonly field: string;
    readonly value: string;
    readonly stories: readonly string[];
  }[];
}

// Watch decodes a wire union into an opaque declaration to preserve live causes.
// Inspect that declaration's encoded shape; its type AST intentionally has no properties.
const outputType = (ast: SchemaAST.AST): SchemaAST.AST => {
  const type = SchemaAST.toType(ast);
  return SchemaAST.isDeclaration(type) ? SchemaAST.toEncoded(ast) : type;
};

const membersOf = (ast: SchemaAST.AST): readonly SchemaAST.AST[] => {
  const type = outputType(ast);
  return SchemaAST.isUnion(type) ? type.types.flatMap((member) => membersOf(member)) : [type];
};

const literals = (ast: SchemaAST.AST): string[] => {
  const type = outputType(ast);
  if (SchemaAST.isLiteral(type)) return typeof type.literal === "string" ? [type.literal] : [];
  if (SchemaAST.isUnion(type)) return type.types.flatMap(literals);
  return [];
};

/** A contract's states: the values of its first state field, across every member of a union. */
const statesOf = (ast: SchemaAST.AST): { field: StateField; states: string[] } | undefined => {
  const type = outputType(ast);
  if (SchemaAST.isUnion(type)) {
    // Choose a field shared by every member. Watch's installation member has a status,
    // but event discriminates the entire watch union regardless of schema member order.
    for (const field of STATE_FIELDS) {
      const values = membersOf(type).map((member) => {
        const object = outputType(member);
        if (!SchemaAST.isObjects(object)) return [];
        const property = object.propertySignatures.find((signature) => signature.name === field);
        return property ? literals(property.type) : [];
      });
      if (values.every((values) => values.length > 0))
        return { field, states: [...new Set(values.flat())] };
    }
    return undefined;
  }
  if (!SchemaAST.isObjects(type)) return undefined;
  for (const field of STATE_FIELDS) {
    const property = type.propertySignatures.find((signature) => signature.name === field);
    if (property) return { field, states: literals(property.type) };
  }
  return undefined;
};

const stateOfData = (data: unknown, field: StateField): unknown =>
  typeof data === "object" && data !== null && field in data
    ? Object.getOwnPropertyDescriptor(data, field)?.value
    : undefined;

/** The state a result reports, when its contract names several. */
export function resultState(result: CommandResult): string | undefined {
  const found = statesOf(outputContracts[result.contract].schema.ast);
  const state = found && stateOfData(result.data, found.field);
  return typeof state === "string" ? state : undefined;
}

/** Explicit branch dimensions: no traversal through error payloads or unrelated schema fields. */
const variantPaths = [
  "action",
  "visibility",
  "operation",
  "trigger",
  "reason",
  "status",
  "choices.kind",
  "choices.kept",
  "result.status",
  "result.action",
  "result.visibility",
  "result.choices.kind",
  "result.choices.kept",
];
const atPath = (ast: SchemaAST.AST, path: readonly string[]): string[] => {
  const type = outputType(ast);
  if (path.length === 0) return literals(type);
  if (SchemaAST.isUnion(type)) return type.types.flatMap((member) => atPath(member, path));
  if (SchemaAST.isArrays(type)) return type.rest.flatMap((member) => atPath(member, path));
  if (!SchemaAST.isObjects(type)) return [];
  const property = type.propertySignatures.find((property) => property.name === path[0]);
  return property ? atPath(property.type, path.slice(1)) : [];
};
const dataAtPath = (data: unknown, path: readonly string[]): unknown[] => {
  if (Array.isArray(data)) return data.flatMap((value) => dataAtPath(value, path));
  if (path.length === 0) return [data];
  if (typeof data !== "object" || data === null) return [];
  return dataAtPath(Object.getOwnPropertyDescriptor(data, path[0]!)?.value, path.slice(1));
};

/** Branch facts from a real result, used to link recordings without retaining its payload. */
export function resultVariants(result: CommandResult): readonly { field: string; value: string }[] {
  if (result.contract !== "sync") return [];
  const main = statesOf(outputContracts[result.contract].schema.ast)?.field;
  return variantPaths
    .filter((field) => field !== main)
    .flatMap((field) =>
      [...new Set(dataAtPath(result.data, field.split(".")))].flatMap((value) =>
        typeof value === "string" ? [{ field, value }] : [],
      ),
    );
}

/** Which states of each output contract have an output story, so missing ones are visible. */
export function storyCoverage(): ReadonlyArray<ContractCoverage> {
  const results = outputStories.filter(OutputStory.$is("Result"));
  return Object.entries(outputContracts).map(([contract, { schema }]) => {
    const stories = results.filter((story) => story.result.contract === contract);
    const found = statesOf(schema.ast);
    if (found === undefined) return { contract, states: [], stories: stories.map(outputStoryKey) };
    return {
      contract,
      field: found.field,
      states: found.states.map((state) => ({
        state,
        stories: stories
          .filter((story) => stateOfData(story.result.data, found.field) === state)
          .map(outputStoryKey),
      })),
      stories: stories.map(outputStoryKey),
      ...(contract === "sync"
        ? {
            variants: found.states.flatMap((state) => {
              const type = outputType(schema.ast);
              const members = membersOf(type);
              const member = members.filter((member) =>
                atPath(member, [found.field]).includes(state),
              );
              return variantPaths
                .filter((field) => field !== found.field)
                .flatMap((field) =>
                  [...new Set(member.flatMap((member) => atPath(member, field.split("."))))].map(
                    (value) => ({
                      state,
                      field,
                      value,
                      stories: stories
                        .filter(
                          (story) =>
                            stateOfData(story.result.data, found.field) === state &&
                            dataAtPath(story.result.data, field.split(".")).includes(value),
                        )
                        .map(outputStoryKey),
                    }),
                  ),
                );
            }),
          }
        : {}),
    };
  });
}

export interface CommandCoverage {
  /** The command as typed after `skit`, such as `author sync`. */
  readonly command: string;
  readonly interactive: boolean;
  readonly rules?: readonly string[];
  readonly scenarios?: readonly {
    readonly name: string;
    readonly description: string;
    readonly flow?: string;
  }[];
  readonly details?: readonly {
    readonly title: string;
    readonly body: string;
    readonly source: string;
  }[];
  readonly invocation: CommandInvocation;
  /** The result contracts the command declares. */
  readonly contracts: readonly string[];
  /** Output stories for these contracts that apply to this command. */
  readonly stories: readonly string[];
}

/** Every command in the executable tree, with the output stories that show what it reports. */
export const commandCoverage = commandDocuments(skitCommand).pipe(
  Effect.map((commands) =>
    commands.map((command): CommandCoverage => {
      const contracts = Object.entries(outputContracts)
        .filter(([, contract]) => command.outputSchemas.includes(contract.id))
        .map(([key]) => key);
      const scenarioSet = scenarioSets.find((set) => set.command === command.path.join(" "));
      return {
        command: command.path.join(" "),
        ...(command.path.join(" ") === "doctor" ? { scenarios: doctorScenarioInventory } : {}),
        ...(command.path.join(" ") === "author sync"
          ? {
              scenarios: [...authorSyncScenarioInventory, ...authorSyncGaps],
              details: authorSyncDetails,
            }
          : {}),
        ...(scenarioSet === undefined ? {} : { rules: scenarioSet.rules }),
        interactive: command.interactive,
        invocation: command.invocation,
        contracts,
        stories: outputStories
          .filter(OutputStory.$is("Result"))
          .filter((story) => contracts.includes(story.result.contract))
          .filter(
            (story) =>
              story.commands === undefined || story.commands.includes(command.path.join(" ")),
          )
          .map(outputStoryKey),
      };
    }),
  ),
);
