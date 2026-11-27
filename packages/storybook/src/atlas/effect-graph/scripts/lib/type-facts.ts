import { basename, relative, resolve } from "node:path";
import {
  SignatureKind, TypeFormatFlags, type Checker, type Project, type Symbol as CompilerSymbol, type Type, type TypeReference,
} from "tsrs/sync";
import * as ts from "../../src/indexer/syntax.ts";
import { elidedText } from "../../src/indexer/composition-walker.ts";
import { layerComposition, type CompositionEdge } from "./layer-composition.ts";
import { isGraphValueType } from "./graph-value-type.ts";

export interface GraphQuery {
  /** Absent for a query by source position alone. */
  readonly graphNodeId?: string | undefined;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly span?: readonly [number, number];
  readonly root?: boolean;
}

interface QueriedNode {
  readonly id: string;
  readonly kind: string;
  readonly span?: { readonly start: number; readonly end: number };
  readonly location: { readonly file: string; readonly line: number; readonly column: number };
}

/** One query per Layer, Effect and entry node of a graph artifact: its exact source span. */
export const graphQueries = (artifact: { readonly graphs: ReadonlyArray<{ readonly graph: { readonly nodes: ReadonlyArray<QueriedNode> } }> }, repo: string): GraphQuery[] => {
  const nodes = new Map(artifact.graphs.flatMap((graph) => graph.graph.nodes)
    .filter((node) => node.kind === "layer" || node.kind === "effect" || node.kind === "root").map((node) => [node.id, node]));
  // Graph ids are opaque; each node records the source span of its expression.
  return [...nodes.values()].flatMap((node) => node.span ? [{
    graphNodeId: node.id, file: resolve(repo, node.location.file), line: node.location.line,
    column: node.location.column, span: [node.span.start, node.span.end] as const, root: node.kind === "root",
  }] : []);
};

/** A service, error or requirement member as the sidecar names it. */
interface Member {
  readonly name: string;
  readonly declarations: ReadonlyArray<string>;
  readonly declarationLocations: ReadonlyArray<{ readonly file: string; readonly line: number; readonly column: number }>;
  readonly generic: boolean;
  readonly unnamed: boolean;
  readonly partial: boolean;
  readonly parameter?: true;
  readonly request?: string;
}
interface Channels {
  readonly provides?: ReadonlyArray<Member>;
  readonly errors?: ReadonlyArray<Member>;
  readonly requires?: ReadonlyArray<Member>;
  readonly outerRequires?: ReadonlyArray<Member>;
  readonly returnedRequires?: ReadonlyArray<Member>;
}
interface Fact extends Channels {
  readonly graphNodeId: string | undefined;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly status: "resolved" | "partial" | "unresolved" | "effect" | "value";
  readonly reason?: string;
  readonly role?: "callback" | "program" | "layer" | "carrier";
  readonly typeName?: string | undefined;
  readonly returns?: "program" | "layer";
  readonly expression?: string;
  readonly typeDeclaration?: ReadonlyArray<string>;
  readonly carrier?: "effect";
  readonly producesLayer?: true;
  readonly innerRequires?: ReadonlyArray<Member>;
}
interface CompositionNode extends Channels {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly label: string;
  readonly layer: boolean;
  readonly name?: string;
  readonly local?: true;
  readonly reference?: "module" | "effect" | "external";
  readonly library?: string;
  readonly combinator?: string;
  readonly origin?: "runtime-bridge" | "ambient-instance";
  readonly ambientSource?: { readonly file: string; readonly start: number; readonly end: number };
  readonly actualProvides: ReadonlyArray<Member>;
}
interface CompositionRoot { readonly graphNodeId: string; readonly node: ts.Node; readonly projectPath: string }

// A module written `export * as Lifecycle from "./self"` names its members through that alias:
// its `Service` is `Lifecycle.Service`. A bare `Service` is ambiguous across a whole application.
const LAYER_NODE_CLASSES = new Set(["GraphValue", "NodeValue", "ProviderNode"]);
const ALIAS = 2097152;
const REQUEST_KINDS = new Set(["Requires", "GlobalRequires", "Error", "GlobalError"]);
const aliased = (checker: Checker, symbol: CompilerSymbol | undefined) =>
  symbol && symbol.flags & ALIAS ? checker.getAliasedSymbol(symbol) : symbol;
const memberKey = (member: { readonly name: string; readonly request?: string; readonly parameter?: true }, declarations: ReadonlyArray<string>) =>
  JSON.stringify([member.name, declarations, member.request ?? null, member.parameter ?? false]);
const unionMembers = (type: Type | undefined): ReadonlyArray<Type> => type?.isUnionType() ? type.getTypes() : type ? [type] : [];

/** An argument of `x.pipe(...)`: a step whose value is its function's return. */
const pipeStep = (node: ts.Node, source: ts.SourceFile) => {
  const parent = node.parent;
  return parent !== undefined && ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)
    && parent.expression.name.getText(source) === "pipe" && [...parent.arguments].some((argument) =>
      argument.getStart(source) === node.getStart(source) && argument.getEnd() === node.getEnd());
};
/** A pipe step's type after it runs: the return of the function its position expects,
 * as effect-tsgo types a Layer pipe argument. */
const stepType = (checker: Checker, node: ts.Node) => {
  try {
    const contextual = checker.getContextualType(node as ts.Expression);
    const signatures = contextual ? checker.getSignaturesOfType(contextual, SignatureKind.Call) : [];
    return signatures.length === 1 ? checker.getReturnTypeOfSignature(signatures[0]!) : undefined;
  } catch { return undefined; }
};
const simpleName = (node: ts.Node): boolean => ts.isIdentifier(node)
  || ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && simpleName(node.expression);
const FUNCTIONS = new Set([ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor]);
const insideFunction = (node: ts.Node) => {
  for (let at = node.parent; at; at = at.parent) if (FUNCTIONS.has(at.kind)) return true;
  return false;
};
/** The name a reader knows a node by: the declaration it initializes, or its source. */
const labelOf = (node: ts.Node) => {
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer?.getStart() === node.getStart()) return parent.name.getText();
  if (parent && ts.isPropertyDeclaration(parent) && parent.initializer?.getStart() === node.getStart()) {
    const owner = ts.isClassDeclaration(parent.parent) ? parent.parent.name?.getText() : undefined;
    return owner ? `${owner}.${parent.name.getText()}` : parent.name.getText();
  }
  // Inline function bodies read as `{…}`, as the source walker labels them.
  return elidedText(node).replace(/\s+/g, " ");
};

export interface ProbeOptions {
  readonly repo: string;
  readonly repoName: string;
  readonly head: string;
  readonly dirty: boolean;
  readonly toolchainVersions: { readonly typescript: string; readonly tsrs: string; readonly typescriptCommit: string };
  readonly extractor: unknown;
  readonly queries: ReadonlyArray<GraphQuery>;
  readonly compact: boolean;
  /** The project a file is typed in. */
  readonly projectFor: (file: string) => string | undefined;
  /** Opens a project. */
  readonly projectOf: (config: string) => Project | undefined;
  readonly projectPaths: ReadonlyArray<string>;
  /** The source text the spans index. */
  readonly textOf: (file: string) => string;
}

/**
 * Compiler facts for application graph nodes: for each query (a graph node's
 * exact source span), what the compiler types it as, with Effect and Layer
 * channels as members, and the compiler's own Layer composition under each
 * resolved Layer.
 */
export const probeTypeFacts = ({
  repo, repoName, head, dirty, toolchainVersions, extractor, queries, compact, projectFor, projectOf, projectPaths, textOf,
}: ProbeOptions) => {
  const inRepo = (path: string) => path.toLowerCase().startsWith(`${repo.toLowerCase()}/`);
  const start = performance.now();
  const projectsByChecker = new WeakMap<Checker, Project>();
  const qualified = (symbol: CompilerSymbol | undefined, name: string, checker: Checker) => {
    const module = /^[A-Za-z_$][\w$]*$/.test(name) ? symbol?.getParent() : undefined;
    if (!module?.name.startsWith('"')) return name;
    for (const member of module.getExports().values()) {
      if (!(member.flags & ALIAS) || member.name === name) continue;
      try { if (checker.getAliasedSymbol(member).id === module.id) return `${member.name}.${name}`; } catch { /* not a self alias */ }
    }
    return name;
  };
  /** `generic` is built from a type parameter (`R`, `Exclude<R, X>`): exact, but the caller decides
   * what it stands for. `unnamed` is what the compiler could not name at all. */
  const memberOf = (item: Type, checker: Checker): Member => {
    const symbol = item.getAliasSymbol() ?? item.getSymbol();
    // Untruncated, so a long type keeps its identity rather than reading as `Brand<...>; ... 5 more ...`.
    const name = qualified(symbol, checker.typeToString(item, undefined, TypeFormatFlags.NoTruncation), checker);
    const generic = item.isTypeParameter() || item.isConditionalType() || item.isIndexedAccessType();
    // TypeScript's own library (`Error`, `Exclude`) names its types; anything else declared
    // outside the checkout is not one the pinned source can vouch for.
    const outside = (path: string) => !inRepo(path) && !/\/lib\.[\w.]+\.d\.ts$/.test(path);
    const flags = { generic, unnamed: item.isErrorType() || name === "any" || name === "unknown"
      || (!generic && (symbol?.declarations.some((declaration) => outside(declaration.path)) ?? false)) };
    return {
      name,
      declarations: symbol?.declarations.map((declaration) => declaration.path) ?? [],
      declarationLocations: (symbol?.declarations ?? []).flatMap((reference) => {
        try {
          const project = projectsByChecker.get(checker);
          const declaration = project && reference.resolve(project);
          if (!declaration) return [];
          const file = declaration.getSourceFile();
          const text = file.getFullText();
          const start = declaration.getStart();
          const before = text.slice(0, start);
          return [{ file: file.fileName, line: before.split("\n").length,
            column: start - before.lastIndexOf("\n") }];
        } catch { return []; }
      }),
      ...flags,
      partial: flags.generic || flags.unnamed,
    };
  };
  /** The members a channel type stands for. `HttpRouter.Request<"Requires", X>`
   * is a router's marker for a service each request needs: it stands for X, per
   * request. A type parameter is marked, since it is not a service. */
  const membersOf = (item: Type, checker: Checker): Member[] => {
    const symbol = item.getAliasSymbol() ?? item.getSymbol();
    if (symbol?.name === "Request" && item.isTypeReference()
      && symbol.declarations.some((declaration) => isEffectDeclaration(declaration.path, "unstable/http/HttpRouter"))) {
      const [kindType, inner] = checker.getTypeArguments(item);
      const request = kindType ? checker.typeToString(kindType).replace(/^"|"$/g, "") : "";
      if (inner && REQUEST_KINDS.has(request)) return unionMembers(inner)
        .filter((member) => checker.typeToString(member) !== "never")
        .flatMap((member) => membersOf(member, checker).map((found) => ({ ...found, request })));
    }
    return [{ ...memberOf(item, checker), ...(item.isTypeParameter() ? { parameter: true as const } : {}) }];
  };
  // Published packages expose dist declarations; the Effect corpus checks its own source.
  // Restrict source recognition to the pinned core package, not lookalike local types.
  const isEffectDeclaration = (path: string, module?: string) => {
    const published = module ? `effect/dist/${module}.d.ts` : "effect/dist/";
    const lower = path.toLowerCase();
    if (module ? lower.endsWith(`/${published.toLowerCase()}`) : lower.includes(`/${published}`)) return true;
    const source = resolve(repo, "packages/effect/src").toLowerCase() + "/";
    if (!lower.startsWith(source)) return false;
    const sourceModule = module === "unstable/http/HttpRouter" ? "http/HttpRouter" : module;
    return sourceModule ? lower === `${source}${sourceModule.toLowerCase()}.ts` : true;
  };
  const isEffectReference = (member: Type, name: "Effect" | "Layer"): member is TypeReference => member.isTypeReference()
    && member.getSymbol()?.name === name
    && (member.getSymbol()?.declarations.some((declaration) => isEffectDeclaration(declaration.path, name)) ?? false);
  /** The type arguments of an Effect type, or undefined when it is not one. */
  const effectArgsOf = (type: Type | undefined, checker: Checker) => {
    const effect = unionMembers(type).find((member) => isEffectReference(member, "Effect"));
    return effect?.isTypeReference() ? checker.getTypeArguments(effect) : undefined;
  };
  const isLayerType = (type: Type | undefined) => unionMembers(type).some((member) => isEffectReference(member, "Layer"));
  // Layer expressions whose facts resolved: each roots a compiler composition.
  const compositionRoots: CompositionRoot[] = [];

  const sourceBodies = new Map<string, { body: string; lines: string[] }>();
  const factAt = ({ file, line, column, graphNodeId, span, root }: GraphQuery): Fact => {
    const result = { graphNodeId, file: relative(repo, file), line, column };
    const projectPath = projectFor(file);
    const project = projectPath && projectOf(projectPath);
    if (!projectPath || !project) return { ...result, status: "unresolved", reason: "file outside selected project" };
    const source = project.program.getSourceFile(file);
    if (!source) return { ...result, status: "unresolved", reason: "source file absent from program" };
    if (!sourceBodies.has(file)) {
      const body = textOf(file);
      sourceBodies.set(file, { body, lines: body.split(/\n/) });
    }
    const { body, lines } = sourceBodies.get(file)!;
    if (line < 1 || line > lines.length || column < 1 || column > lines[line - 1]!.length + 1)
      return { ...result, status: "unresolved", reason: "position outside source" };
    const offset = lines.slice(0, line - 1).reduce((total, part) => total + part.length + 1, 0) + column - 1;
    const path: ts.Node[] = [];
    const descend = (node: ts.Node): void => {
      if (node.getStart(source) > offset || node.getEnd() <= offset) return;
      path.push(node);
      node.forEachChild(descend);
    };
    descend(source);
    const checker = project.checker;
    projectsByChecker.set(checker, project);
    const atSpan = span ? path.filter((node) => node.getStart(source) === span[0] && node.getEnd() === span[1])
      : path.reverse();
    // An entry point's type is what it still needs from whatever runs it. A Worker class is typed
    // through the call that gives it its program (`MapleApi.make(props, init)`), or else the call it extends.
    const candidates = root ? atSpan.flatMap((node): ts.Node[] => {
      if (!ts.isClassDeclaration(node)) return [node];
      const name = node.name?.getText(source);
      const made: ts.Node[] = [];
      const find = (current: ts.Node): void => {
        if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)
          && current.expression.name.getText(source) === "make" && current.expression.expression.getText(source) === name
          && current.arguments.length >= 2) made.push(current);
        current.forEachChild(find);
      };
      if (name) find(source);
      const heritage = node.heritageClauses?.[0]?.types[0];
      const extended = heritage && ts.isExpressionWithTypeArguments(heritage) ? heritage.expression : undefined;
      return [...made, ...(extended ? [extended] : [])];
    }) : atSpan;
    // A function returning an Effect carries a separate callback contract. Its return
    // type says what that program needs; it does not say when the caller runs it.
    const exactExpression = candidates.at(-1);
    const exactValueType = exactExpression ? checker.getTypeAtLocation(exactExpression) : undefined;
    const callbackReturns = exactValueType && !exactValueType.isErrorType()
      ? checker.getSignaturesOfType(exactValueType, SignatureKind.Call).map((signature) => checker.getReturnTypeOfSignature(signature)) : [];
    const callbackShapes = callbackReturns.flatMap((returned) => unionMembers(returned)
      .map((member) => {
        const effect = effectArgsOf(member, checker);
        return effect ? { returns: "program" as const, args: effect }
          : member.isTypeReference() && isLayerType(member) ? { returns: "layer" as const, args: checker.getTypeArguments(member) } : undefined;
      }));
    const callbackContracts = callbackShapes.flatMap((shape) => shape ? [shape] : []);
    if (exactExpression && !pipeStep(exactExpression, source) && callbackShapes.length > 0 && callbackContracts.length === callbackShapes.length
      && callbackContracts.every((shape) => shape.args.length === 3 && shape.returns === callbackContracts[0]!.returns)) {
      const joined = (index: number) => [...new Map(callbackContracts.flatMap(({ args }) => unionMembers(args[index])
        .filter((member) => checker.typeToString(member) !== "never").flatMap((member) => membersOf(member, checker)))
        .map((member) => [memberKey(member, member.declarations), member])).values()];
      const returns = callbackContracts[0]!.returns;
      const requires = joined(2), errors = joined(1), provides = returns === "layer" ? joined(0) : [];
      return { ...result, status: [...requires, ...provides].some((member) => member.partial) ? "partial" : "resolved",
        ...(errors.some((member) => member.partial) ? { reason: "errors include unresolved members" } : {}),
        role: "callback", typeName: "Function", returns, provides, requires, errors };
    }
    for (const node of candidates) {
      const type = pipeStep(node, source) ? stepType(checker, node) ?? checker.getTypeAtLocation(node) : checker.getTypeAtLocation(node);
      // A conditional expression types as a union of its Layers; each one contributes.
      // `Effect<…> & Named<Id> & {…}` (a Worker class's call): the Effect or Layer member carries the channels.
      const carrierOf = (member: Type) => member.isIntersectionType()
        ? member.getTypes().find((part) => part.isTypeReference() && ["Effect", "Layer"].includes(part.getSymbol()?.name ?? "")) ?? member
        : member;
      const alternatives = unionMembers(type).map(carrierOf);
      // Local correction: Command is a carrier, with E/R before application provision.
      const command = alternatives.find((part) => part.isTypeReference() && part.getSymbol()?.name === "Command"
        && part.getSymbol()?.declarations.some((decl) => /effect\/dist\/(?:unstable\/)?cli\/Command\.d\.ts$/i.test(decl.path)));
      if (command?.isTypeReference()) {
        const args = checker.getTypeArguments(command);
        if (args.length >= 5) {
          const channel = (type: Type) => unionMembers(type).filter((part) => checker.typeToString(part) !== "never")
            .flatMap((part) => membersOf(part, checker));
          const requires = channel(args[4]!), errors = channel(args[3]!);
          return { ...result, status: requires.some((part) => part.partial) ? "partial" : "resolved",
            role: "carrier", typeName: "Command", provides: [], requires, errors,
            ...(errors.some((part) => part.partial) ? { reason: "errors include unresolved members" } : {}) };
        }
      }
      const shapes = alternatives.map((alternative) => {
        if (!alternative.isTypeReference()) return undefined;
        const symbolName = alternative.getSymbol()?.name ?? "";
        const paths = alternative.getSymbol()?.declarations.map((declaration) => declaration.path as string) ?? [];
        // A LayerNode graph carries what it provides and can fail with; its requirements are resolved by the graph.
        const layerNode = LAYER_NODE_CLASSES.has(symbolName) && paths.some((path) => /(?:^|\/)effect\/layer-node\.ts$/.test(path));
        // An Effect's success value is not something it provides; only its errors and requirements are contract.
        const isEffect = symbolName === "Effect" && paths.some((path) => isEffectDeclaration(path, "Effect"));
        if (isEffect) { const effectArgs = checker.getTypeArguments(alternative); return effectArgs.length === 3 ? { layerNode: false, isEffect, paths, args: effectArgs } : undefined; }
        if (!layerNode && (symbolName !== "Layer"
          || !paths.some((path) => isEffectDeclaration(path, "Layer")))) return undefined;
        const args = checker.getTypeArguments(alternative);
        return args.length === 3 ? { layerNode, isEffect: false, paths, args } : undefined;
      });
      const resolved = shapes.flatMap((shape) => shape ? [shape] : []);
      if (shapes.length === 0 || resolved.length !== shapes.length) continue;
      if (resolved.some((shape) => shape.paths.some((path) => !inRepo(path))))
        return { ...result, status: "unresolved", reason: "Layer declaration outside pinned checkout" };
      const layerNode = resolved.every((shape) => shape.layerNode);
      const effects = resolved.every((shape) => shape.isEffect);
      const declarationPaths = [...new Set(resolved.flatMap((shape) => shape.paths))];
      const members = (part: Type) => part.isUnionType() ? part.getTypes() : part.isIntersectionType() ? part.getTypes() : [part];
      const services = (part: Type) => members(part).filter((item) => checker.typeToString(item) !== "never")
        .flatMap((item) => membersOf(item, checker));
      const joined = (index: number) => [...new Map(resolved.flatMap((shape) => services(shape.args[index]!))
        .map((service) => [memberKey(service, service.declarations), service])).values()];
      const channels = { provides: effects ? [] : joined(0), errors: joined(1), requires: layerNode ? [] : joined(2) };
      if (graphNodeId && !root && !layerNode && resolved.every((shape) => !shape.isEffect)) compositionRoots.push({ graphNodeId, node, projectPath });
      // An Effect whose value is an Effect (`HttpRouter.toHttpEffect`'s per-request handler): what that
      // inner Effect requires has moved into it, not been met.
      const inner = effects ? [...new Map(resolved.flatMap((shape) => {
        const args = effectArgsOf(shape.args[0], checker);
        return args ? services(args[2]!) : [];
      }).map((service) => [memberKey(service, service.declarations), service])).values()] : [];
      return {
        // What it provides and requires is the contract claims rest on; an
        // incomplete error channel (`unknown`) is noted, not disqualifying.
        ...result, status: [...channels.provides, ...channels.requires].some((item) => item.partial) ? "partial" : "resolved",
        ...(![...channels.provides, ...channels.requires].some((item) => item.partial) && channels.errors.some((item) => item.partial)
          ? { reason: "errors include unresolved members" } : {}),
        expression: body.slice(node.getStart(source), node.getEnd()).replace(/\s+/g, " ").slice(0, 160),
        typeDeclaration: declarationPaths, ...channels,
        role: effects ? "program" : "layer",
        typeName: effects ? "Effect" : layerNode ? "LayerNode" : "Layer",
        ...(effects ? { carrier: "effect" as const } : {}),
        // An Effect whose value is a Layer produces it (`Layer.unwrap(Effect.gen(... return layer))`).
        ...(effects && resolved.some((shape) => isLayerType(shape.args[0])) ? { producesLayer: true as const } : {}),
        ...(inner.length > 0 ? { innerRequires: inner } : {}),
      };
    }
    // The compiler typed the expression and it is not a Layer: a value or a replacement handed
    // to a composition. Opaque unknown values are data; erased any and error types stay unresolved.
    // An ExpressionStatement and its expression can share the same span.
    // Query the innermost match: statements themselves have the compiler's error type.
    const exact = candidates.at(-1);
    const exactType = span && exact ? checker.getTypeAtLocation(exact) : undefined;
    const exactText = exactType ? checker.typeToString(exactType) : "";
    if (isGraphValueType(exactType, exactText)) {
      if (isEffectReference(exactType, "Effect")) return { ...result, status: "effect", reason: `type ${exactText.replace(/\s+/g, " ").slice(0, 80)}` };
      return { ...result, status: "value", typeName: exactType.getSymbol()?.name ?? exactType.getAliasSymbol()?.name,
        reason: `type ${exactText.replace(/\s+/g, " ").slice(0, 80)}` };
    }
    return { ...result, status: "unresolved", reason: span ? "no exact Effect Layer expression at graph span"
      : "no Effect Layer type at position" };
  };
  // Call contexts change the source walk's bindings, not the compiler type at
  // a pinned syntax span. Probe once and retain a fact/anchor for every node id.
  const byPosition = new Map<string, { fact: Fact; composition: CompositionRoot | undefined }>();
  const facts = queries.map((query) => {
    const key = JSON.stringify([query.file, query.span ?? [query.line, query.column], query.root ?? false]);
    const cached = byPosition.get(key);
    if (cached) {
      if (cached.composition && query.graphNodeId) compositionRoots.push({ ...cached.composition, graphNodeId: query.graphNodeId });
      return { ...cached.fact, graphNodeId: query.graphNodeId };
    }
    const before = compositionRoots.length;
    const fact = factAt(query);
    byPosition.set(key, { fact, composition: compositionRoots.length > before ? compositionRoots.at(-1) : undefined });
    return fact;
  });
  // The compiler's own account of how each Layer is composed: effect-tsgo's
  // Layer graph rules, run from every resolved Layer expression in the graph.
  const composition = {
    nodes: new Map<string, CompositionNode>(), edges: new Map<string, CompositionEdge>(),
    anchors: [] as Array<{ graphNodeId: string; key: string }>,
  };
  const lineStarts = new Map<string, number[]>();
  const positionOf = (fileName: string, offset: number) => {
    let starts = lineStarts.get(fileName);
    if (!starts) {
      starts = [0];
      const text = textOf(fileName);
      for (let index = 0; index < text.length; index++) if (text[index] === "\n") starts.push(index + 1);
      lineStarts.set(fileName, starts);
    }
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1]! <= offset) line++;
    return { line: line + 1, column: offset - starts[line]! + 1 };
  };
  const writtenName = (node: ts.Node) => simpleName(node) ? node.getText() : undefined;
  for (const projectPath of [...new Set(compositionRoots.map((root) => root.projectPath))]) {
    // Each root's project opened when its fact resolved.
    const project = projectOf(projectPath)!;
    const checker = project.checker;
    projectsByChecker.set(checker, project);
    const members = (type: Type) => unionMembers(type).filter((member) => checker.typeToString(member) !== "never");
    const symbolAt = (node: ts.Node) => aliased(checker, checker.getSymbolAtLocation(node));
    /** The package declaration a name outside the checkout resolves to, as `package/path#index`. */
    const libraryDeclaration = (node: ts.Node) => {
      if (!simpleName(node)) return undefined;
      try {
        const declarations = symbolAt(node)?.declarations ?? [];
        if (declarations.length !== 1) return undefined;
        const path = declarations[0]!.path;
        if (inRepo(path) && !/\/node_modules\//.test(path)) return undefined;
        return `${path.replace(/^.*\/node_modules\//, "")}#${declarations[0]!.index}`;
      } catch { return undefined; }
    };
    /** `module` for a name or callee the checkout declares, `effect` for Effect's own, `external` otherwise. */
    const declaredBy = (node: ts.Node): CompositionNode["reference"] => {
      const named = ts.isCallExpression(node) ? node.expression : node;
      if (!simpleName(named)) return undefined;
      try {
        const paths = symbolAt(named)?.declarations.map((declaration) => declaration.path as string) ?? [];
        if (paths.length === 0) return undefined;
        // Effect's own combinators (`Layer.provide`, `Effect.gen`); other exports of the package, such as
        // FetchHttpClient.layer, are a library's Layers like any other.
        if (paths.some((path) => (isEffectDeclaration(path, "Layer") || isEffectDeclaration(path, "Effect")))) return "effect";
        return paths.some((path) => inRepo(path) && !/\/node_modules\//.test(path)) ? "module" : "external";
      } catch { return undefined; }
    };
    const effectRequirements = (node: ts.Node | undefined) => {
      if (!node) return undefined;
      let type: Type | undefined = checker.getTypeAtLocation(node);
      const signatures = checker.getSignaturesOfType(type, SignatureKind.Call);
      if (signatures.length === 1) type = checker.getReturnTypeOfSignature(signatures[0]!);
      if ("asteriskToken" in node && node.asteriskToken && type.isTypeReference() && type.getSymbol()?.name === "Generator") {
        type = checker.getTypeArguments(type)[0];
      }
      const channels = unionMembers(type).map((alternative) => effectArgsOf(alternative, checker));
      if (!channels.length || channels.some((args) => args?.length !== 3)) return undefined;
      return channels.flatMap((args) => members(args![2]!));
    };
    const isManagedRuntimeMake = (callee: ts.Node) => {
      try {
        const symbol = symbolAt(callee);
        return symbol?.name === "make" && symbol.declarations.some((declaration) =>
          isEffectDeclaration(declaration.path, "ManagedRuntime"));
      } catch { return false; }
    };
    const composer = layerComposition({
      effectRequirements, isManagedRuntimeMake,
      checker, project, kind: ts.SyntaxKind,
      inRepo: (path) => inRepo(path) && !/\/node_modules\//.test(path),
      assignable: (source, target) => { try { return checker.isTypeAssignableTo(source, target); } catch { return false; } },
      isEffectPipe: (identifier) => {
        try {
          return symbolAt(identifier)?.declarations.some((declaration) => isEffectDeclaration(declaration.path)) ?? false;
        } catch { return false; }
      },
      layerMember: (callee) => {
        if (!ts.isPropertyAccessExpression(callee) && !ts.isIdentifier(callee)) return undefined;
        try {
          const symbol = symbolAt(callee);
          return symbol?.declarations.some((declaration) => isEffectDeclaration(declaration.path, "Layer")) ? symbol.name : undefined;
        } catch { return undefined; }
      },
      layerChannels: (type) => {
        if (!isEffectReference(type, "Layer")) return undefined;
        const args = checker.getTypeArguments(type);
        return args.length === 3 ? { provides: members(args[0]!), requires: members(args[2]!), rIn: args[2]! } : undefined;
      },
    });
    const membersOfAll = (types: ReadonlyArray<Type>) => types.flatMap((type) => membersOf(type, checker));
    for (const { graphNodeId, node, projectPath: rootProject } of compositionRoots) {
      if (rootProject !== projectPath) continue;
      const rootKey = composer.keyOf(node);
      if (!composition.nodes.has(rootKey)) {
        const { nodes, edges } = composer.extract(node);
        for (const [key, holder] of nodes) if (!composition.nodes.has(key)) {
          const { node: member, info } = holder;
          const fileName = member.getSourceFile().fileName;
          const reference = declaredBy(member), library = libraryDeclaration(member), name = writtenName(member);
          const combinator = composer.combinatorOf(member);
          composition.nodes.set(key, {
            file: relative(repo, fileName), start: member.getStart(), end: member.getEnd(),
            ...positionOf(fileName, member.getStart()), label: labelOf(member),
            // Whose Layer this is, by the declaration its name or callee resolves to.
            ...(reference ? { reference } : {}),
            // A library's Layer named here: its declaration is its identity, however many places name it.
            ...(library ? { library } : {}),
            // Written inside a function: a walker may expand it once per call, with different bindings.
            ...(insideFunction(member) ? { local: true as const } : {}),
            // What is written, when it is a name: `NodePtyAdapter.layer` where the label is the `PtyAdapterLive` it initializes.
            ...(name ? { name } : {}),
            // A composite of Layers need not be one (`Layer.launch(x)` is an Effect); upstream keeps it untyped.
            layer: info !== undefined,
            ...(combinator ? { combinator } : {}),
            ...(holder.origin ? { origin: holder.origin } : {}),
            ...(holder.ambientSource ? { ambientSource: { ...holder.ambientSource, file: relative(repo, holder.ambientSource.file) } } : {}),
            ...(holder.outerRequires === undefined ? {} : { outerRequires: membersOfAll(holder.outerRequires) }),
            ...(holder.returnedRequires === undefined ? {} : { returnedRequires: membersOfAll(holder.returnedRequires) }),
            provides: membersOfAll(info?.provides ?? []),
            requires: membersOfAll(info?.requires ?? []),
            actualProvides: membersOfAll(info?.actualProvides ?? []),
          });
        }
        for (const edge of edges) composition.edges.set(`${edge.from}\0${edge.to}\0${edge.relationship}\0${edge.index ?? ""}`, edge);
      }
      if (composition.nodes.has(rootKey)) composition.anchors.push({ graphNodeId, key: rootKey });
    }
  }
  const output = {
    repo: repoName, projects: projectPaths.map((path) => relative(repo, path)),
    commit: head,
    dirty,
    typescript: toolchainVersions.typescript,
    tsrs: toolchainVersions.tsrs,
    typescriptCommit: toolchainVersions.typescriptCommit,
    elapsedMs: Math.round(performance.now() - start), facts,
  };
  if (!compact) return output;
  const inCheckout = (path: string) => path.toLowerCase().startsWith(`${repo.toLowerCase()}/`) ? path.slice(repo.length + 1) : path;
  const channelsOf = (holder: Channels) => [holder.provides, holder.errors, holder.requires, holder.outerRequires, holder.returnedRequires];
  const names = new Map<string, Omit<Member, "declarationLocations" | "generic" | "unnamed" | "partial"> & {
    readonly declarationLocations?: Member["declarationLocations"]; readonly partial?: true; readonly generic?: true;
  }>();
  const compositionNodes = [...composition.nodes.values()];
  for (const holder of [...facts, ...compositionNodes]) for (const channel of channelsOf(holder))
    for (const member of channel ?? []) {
      const declarations = member.declarations.map(inCheckout);
      const key = memberKey(member, declarations);
      names.set(key, { name: member.name, declarations,
        ...(member.declarationLocations?.length ? { declarationLocations: member.declarationLocations.map((location) => ({ ...location,
          file: inCheckout(location.file) })) } : {}),
        ...(member.request ? { request: member.request } : {}), ...(member.parameter ? { parameter: true as const } : {}),
        ...(member.unnamed || names.get(key)?.partial ? { partial: true as const } : {}),
        ...(member.generic || names.get(key)?.generic ? { generic: true as const } : {}) });
    }
  const types = [...names].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value], index) => ({ id: `t${index + 1}`, key, ...value }));
  const typeId = new Map(types.map(({ key, id }) => [key, id]));
  const ids = (members: ReadonlyArray<Member> = []) => members.map((member) => typeId.get(memberKey(member, member.declarations.map(inCheckout)))!);
  const nodeId = new Map([...composition.nodes.keys()].map((key, index) => [key, `c${index + 1}`]));
  return {
    format: "layer-type-facts-v1", repo: basename(repo), commit: head,
    compiler: toolchainVersions,
    extractor,
    projects: output.projects,
    types: types.map(({ key: _key, ...type }) => type),
    facts: facts.map((fact) => ({
      nodeId: fact.graphNodeId, status: fact.status,
      ...(fact.reason ? { reason: fact.reason } : {}),
      ...(fact.carrier ? { carrier: fact.carrier } : {}),
      ...(fact.role ? { role: fact.role } : {}),
      ...(fact.typeName && !fact.typeName.startsWith("__") ? { typeName: fact.typeName } : {}),
      ...(fact.returns ? { returns: fact.returns } : {}),
      ...(fact.producesLayer ? { producesLayer: true } : {}),
      ...(fact.innerRequires ? { innerRequires: ids(fact.innerRequires) } : {}),
      provides: ids(fact.provides), errors: ids(fact.errors), requires: ids(fact.requires),
    })),
    composition: {
      nodes: [...composition.nodes].map(([key, node]) => ({
        id: nodeId.get(key), file: node.file, span: { start: node.start, end: node.end },
        line: node.line, column: node.column, label: node.label, layer: node.layer,
        ...(node.name ? { name: node.name } : {}),
        ...(node.local ? { local: true } : {}),
        ...(node.reference ? { reference: node.reference } : {}),
        ...(node.library ? { library: node.library } : {}),
        ...(node.combinator ? { combinator: node.combinator } : {}),
        ...(node.origin ? { origin: node.origin } : {}),
        ...(node.ambientSource ? { ambientSource: node.ambientSource } : {}),
        ...(node.outerRequires === undefined ? {} : { outerRequires: [...new Set(ids(node.outerRequires))] }),
        ...(node.returnedRequires === undefined ? {} : { returnedRequires: [...new Set(ids(node.returnedRequires))] }),
        provides: ids(node.provides), requires: ids(node.requires), actualProvides: ids(node.actualProvides),
      })),
      edges: [...composition.edges.values()].filter((edge) => nodeId.has(edge.from) && nodeId.has(edge.to))
        .map((edge) => ({ from: nodeId.get(edge.from), to: nodeId.get(edge.to), relationship: edge.relationship,
          ...(edge.index === undefined ? {} : { index: edge.index }) })),
      anchors: composition.anchors.map((anchor) => ({ nodeId: anchor.graphNodeId, composition: nodeId.get(anchor.key) })),
    },
  };
};
