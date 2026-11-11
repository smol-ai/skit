import type { CommandInvocation, InvocationParameter } from "../storybook/contracts.js";
import { Context, Option } from "effect";
import { Command, Param, Primitive } from "effect/cli";
import type { HelpDoc } from "effect/cli";
import { CommandParameters, GlobalParameters, SharedParameters } from "./definition.js";
import { skitBuiltInFlags } from "./parameters.js";

function parameters(config: Command.Command.Config): Param.Any[] {
  const read = (value: unknown): Param.Any[] => {
    if (Param.isParam(value)) return [value];
    if (Array.isArray(value)) return value.flatMap(read);
    if (typeof value === "object" && value !== null) return Object.values(value).flatMap(read);
    return [];
  };
  return read(config);
}

type Node =
  | Param.Single<Param.ParamKind, unknown>
  | Param.Map<Param.ParamKind, unknown, unknown>
  | Param.Transform<Param.ParamKind, unknown, unknown>
  | Param.Optional<Param.ParamKind, unknown>
  | Param.Variadic<Param.ParamKind, unknown>;

// Effect 4.1.2 publishes these node types, but its traversal helpers are internal-only.
function singles(param: Param.Any): Param.Single<Param.ParamKind, unknown>[] {
  const node = param as Node;
  if (node._tag === "Single") return [node];
  if (node._tag === "Transform")
    return [
      ...singles(node.param),
      ...node.alternatives.flatMap((alternative) => singles(alternative())),
    ];
  return singles(node.param);
}

function parameterMetadata(param: Param.Any): {
  optional: boolean;
  repeated: boolean;
  min: number;
  max?: number;
} {
  const node = param as Node;
  if (node._tag === "Single") return { optional: false, repeated: false, min: 1, max: 1 };
  const inner = parameterMetadata(node.param);
  if (node._tag === "Optional") return { ...inner, optional: true, min: 0 };
  if (node._tag === "Variadic")
    return {
      ...inner,
      repeated: true,
      min: Option.getOrElse(node.min, () => 0),
      max: Option.getOrUndefined(node.max),
    };
  return inner;
}

/** Choice keys live on Effect's Choice primitive; validate the installed runtime shape. */
function choices(primitive: Primitive.Primitive<unknown>): readonly string[] | undefined {
  if (primitive._tag !== "Choice" || !("choiceKeys" in primitive)) return undefined;
  const keys = primitive.choiceKeys;
  return Array.isArray(keys) && keys.every((key): key is string => typeof key === "string")
    ? keys
    : undefined;
}

/** Evaluate only pure Map nodes on an absent value, never parsers, effects or validation transforms. */
function omittedValue(param: Param.Any): Option.Option<unknown> {
  const node = param as Node;
  switch (node._tag) {
    case "Single":
      return Option.none();
    case "Optional":
      return Option.some(Option.none());
    case "Variadic":
      return Option.getOrElse(node.min, () => 0) === 0 ? Option.some([]) : Option.none();
    case "Map":
      return Option.map(omittedValue(node.param), node.f);
    case "Transform":
      return Option.none();
  }
}

function hasTransform(param: Param.Any): boolean {
  const node = param as Node;
  if (node._tag === "Transform") return true;
  if (node._tag === "Single") return false;
  return hasTransform(node.param);
}

function describe(param: Param.Any): InvocationParameter[] {
  const metadata = parameterMetadata(param);
  const omitted = omittedValue(param);
  const defaultValue = Option.isNone(omitted)
    ? { status: "unavailable" as const }
    : omitted.value === undefined ||
        (Option.isOption(omitted.value) && Option.isNone(omitted.value))
      ? { status: "none" as const }
      : { status: "value" as const, value: JSON.stringify(omitted.value) };
  return singles(param).map((single) => {
    const boolean = single.kind === "flag" && single.primitiveType._tag === "Boolean";
    const required = !metadata.optional && (!metadata.repeated || metadata.min > 0);
    const description = Option.getOrElse(single.description, () => "");
    const accepted = choices(single.primitiveType);
    return {
      name: single.name,
      aliases: single.aliases.map((alias) => (alias.length === 1 ? `-${alias}` : `--${alias}`)),
      type: Primitive.getTypeName(single.primitiveType),
      ...(single.typeName === undefined ? {} : { valueName: single.typeName }),
      description,
      required,
      repeated: metadata.repeated,
      min: metadata.repeated ? metadata.min : required ? 1 : 0,
      ...(metadata.max === undefined ? {} : { max: metadata.max }),
      ...(accepted === undefined ? {} : { choices: accepted }),
      ...(boolean && single.negation !== false
        ? { negation: `--${single.negation ?? `no-${single.name}`}` }
        : {}),
      ...(single.optionalValue === undefined ? {} : { optionalValue: single.optionalValue }),
      default: required ? { status: "none" } : defaultValue,
      missing: [
        ...(description ? [] : ["Description is not defined."]),
        ...(single.primitiveType._tag === "Choice" && accepted === undefined
          ? ["Accepted values could not be extracted."]
          : []),
        ...(!required && defaultValue.status === "unavailable"
          ? ["Default cannot be extracted without executing a parser."]
          : []),
        ...(hasTransform(param) ? ["Additional parser checks are not documented."] : []),
      ],
    };
  });
}

/** Public command annotations and Effect's own help model describe the same executable grammar. */
export function commandInvocation(
  document: HelpDoc.HelpDoc,
  ancestors: readonly { readonly annotations: Context.Context<never> }[],
  handlerRules: readonly string[] = [],
): CommandInvocation {
  const current = ancestors.at(-1);
  const local = current && Context.getOption(current.annotations, CommandParameters);
  const declared = local && Option.isSome(local) ? parameters(local.value) : [];
  const globalFlags = [
    ...new Set([
      ...skitBuiltInFlags,
      ...ancestors.flatMap((ancestor) =>
        Option.getOrElse(Context.getOption(ancestor.annotations, GlobalParameters), () => []),
      ),
    ]),
  ];
  const globals = [...new Set(globalFlags.map((flag) => flag.flag))];
  const globalParameters = new Set(globals);
  const globalActions = new Set(
    globalFlags.filter((flag) => flag._tag === "Action").map((flag) => flag.flag),
  );
  const args = declared.filter((param) => param.kind === "argument").flatMap(describe);
  const options: CommandInvocation["options"][number][] = declared
    .filter((param) => param.kind === "flag" && !globalParameters.has(param))
    .flatMap(describe)
    .map((param) => ({ ...param, scope: "local" }));
  for (const ancestor of [...ancestors].reverse()) {
    const shared = Context.getOption(ancestor.annotations, SharedParameters);
    if (Option.isNone(shared)) continue;
    for (const option of parameters(shared.value)
      .filter((param) => !globalParameters.has(param))
      .flatMap(describe))
      if (!options.some((present) => present.name === option.name))
        options.push({ ...option, scope: "inherited" });
  }
  const optionTokens = new Set(
    options.flatMap((option) => [
      `--${option.name}`,
      ...option.aliases,
      ...(option.negation ? [option.negation] : []),
    ]),
  );
  for (const global of globals)
    for (const option of describe(global)) {
      const shadowedTokens = [
        `--${option.name}`,
        ...option.aliases,
        ...(option.negation ? [option.negation] : []),
      ].filter((token) => optionTokens.has(token));
      const path = document.commandPath;
      options.push({
        ...option,
        required: false,
        scope: "global",
        globalKind: globalActions.has(global) ? "action" : "setting",
        ...(shadowedTokens.length ? { shadowedTokens } : {}),
        ...(shadowedTokens.length && path && path.length > 1
          ? { beforeCommandExample: [path[0], shadowedTokens[0], ...path.slice(1)].join(" ") }
          : {}),
      });
    }
  return {
    usage: document.usage,
    handlerRules,
    summary: document.description,
    examples: (document.examples ?? []).map((example) => example.command),
    arguments: args,
    options,
    missing: [
      ...(!local || Option.isNone(local)
        ? ["Executable parameter definitions are not attached to this command."]
        : []),
      ...(document.args ?? [])
        .filter((arg) => !args.some((item) => item.name === arg.name))
        .map((arg) => `Argument ${arg.name} has no attached definition.`),
      ...[...document.flags, ...(document.inheritedFlags ?? []), ...(document.globalFlags ?? [])]
        .filter((flag) => !options.some((item) => item.name === flag.name))
        .map((flag) => `Option --${flag.name} has no attached definition.`),
    ],
  };
}
