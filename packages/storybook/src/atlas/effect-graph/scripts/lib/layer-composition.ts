/**
 * How Layers compose, read from the compiler: a port of effect-tsgo's Layer
 * graph extraction (Effect-TS/tsgo `internal/layergraph/extract.go`, read
 * 2026-09-30) onto TypeScript 7's sync API. effect-tsgo only publishes its
 * graph as Mermaid in a hover on a declaration name; running the same rules
 * here reaches any Layer expression and keeps full paths, spans and type ids.
 *
 * The rules are upstream's, driven by types rather than by combinator names:
 * - a pipe (`x.pipe(a, b)` or Effect's `pipe(x, a, b)`) links its subject and
 *   arguments in order, and the pipe to the last of them;
 * - a call links Layer arguments; a Layer-returning call retains those links
 *   even alongside configuration or other non-Layer arguments;
 * - an array literal links its Layer elements;
 * - a name (`a`, `a.b.c`) with one declaration links to that declaration's
 *   initializer;
 * - each node's provides and requires are the members of its `Layer<ROut, E,
 *   RIn>` type, a pipe argument typed as the return of its contextual function.
 *
 * Deliberate differences: a name declared outside the pinned checkout (library
 * internals under node_modules) is not followed, and names are followed without
 * a depth limit; nodes are identified by file and span. A supplemental pass
 * links local factory return definitions, unwrap return sites and runtime
 * contexts. Factory edges retain the caller and describe source definitions;
 * they do not instantiate generic parameters or evaluate configuration.
 */
import { SignatureKind, type Checker, type Project, type Symbol as CompilerSymbol, type Type } from "tsrs/sync";
import type * as ts from "../../src/indexer/syntax.ts";

export type CompositionRelationship = "pipe" | "call" | "arrayLiteral" | "symbol" | "factory" | "returned" | "runtime";
export interface CompositionEdge {
  readonly from: string;
  readonly to: string;
  readonly relationship: CompositionRelationship;
  readonly index?: number;
}
export interface LayerInfo {
  readonly provides: ReadonlyArray<Type>;
  readonly requires: ReadonlyArray<Type>;
  readonly actualProvides: ReadonlyArray<Type>;
}
export interface CompositionHolder {
  readonly node: ts.Node;
  readonly info: LayerInfo | undefined;
  outerRequires?: ReadonlyArray<Type> | undefined;
  returnedRequires?: ReadonlyArray<Type>;
  origin?: "runtime-bridge" | "ambient-instance";
  ambientSource?: { readonly file: string; readonly start: number; readonly end: number };
}

export interface LayerCompositionOptions {
  readonly checker: Checker;
  /** The project, to resolve declaration handles. */
  readonly project: Project;
  /** The compiler's SyntaxKind; tests drive the walker with another compiler's. */
  readonly kind: typeof ts.SyntaxKind;
  /** Whether a file path belongs to the pinned checkout. */
  readonly inRepo: (path: string) => boolean;
  /** A Layer type's provides and requires members, or undefined when it is not a Layer. */
  readonly layerChannels: (type: Type) => { readonly provides: ReadonlyArray<Type>; readonly requires: ReadonlyArray<Type>; readonly rIn: Type } | undefined;
  readonly assignable: (source: Type, target: Type) => boolean;
  /** Whether an identifier names Effect's `pipe`. */
  readonly isEffectPipe: (identifier: ts.Identifier) => boolean;
  /** Which member of Effect's `Layer` module a callee resolves to. */
  readonly layerMember: (callee: ts.Node) => string | undefined;
  readonly effectRequirements?: (node: ts.Node | undefined) => ReadonlyArray<Type> | undefined;
  readonly isManagedRuntimeMake?: (callee: ts.Node) => boolean;
}

export const layerComposition = ({
  checker, project, kind, inRepo, layerChannels, assignable, isEffectPipe, layerMember,
  effectRequirements = () => undefined, isManagedRuntimeMake = () => false,
}: LayerCompositionOptions) => {
  const is = <T extends ts.Node>(syntax: ts.SyntaxKind) => (node: ts.Node | undefined): node is T => node?.kind === syntax;
  const isCall = is<ts.CallExpression>(kind.CallExpression);
  const isPropertyAccess = is<ts.PropertyAccessExpression>(kind.PropertyAccessExpression);
  const isIdentifier = is<ts.Identifier>(kind.Identifier);
  const isArrayLiteral = is<ts.ArrayLiteralExpression>(kind.ArrayLiteralExpression);
  const isReturn = is<ts.ReturnStatement>(kind.ReturnStatement);
  const isYield = is<ts.YieldExpression>(kind.YieldExpression);
  const isBlock = is<ts.Block>(kind.Block);
  const isConditional = is<ts.ConditionalExpression>(kind.ConditionalExpression);
  const FUNCTIONS = new Set([kind.ArrowFunction, kind.FunctionExpression, kind.FunctionDeclaration, kind.MethodDeclaration]);
  const functionLike = (node: ts.Node | undefined): node is ts.FunctionLikeDeclaration => node !== undefined && FUNCTIONS.has(node.kind);
  /** A variable or property declaration's initializer. */
  const initializerOf = (node: ts.Node | undefined): ts.Expression | undefined =>
    node && (node.kind === kind.VariableDeclaration || node.kind === kind.PropertyDeclaration)
      ? (node as ts.VariableDeclaration | ts.PropertyDeclaration).initializer : undefined;
  /** Any declaration's initializer: a variable, property, parameter or binding element. */
  const anyInitializer = (node: ts.Node | undefined): ts.Expression | undefined =>
    node && "initializer" in node ? node.initializer as ts.Expression | undefined : undefined;

  const keyOf = (node: ts.Node) => `${node.getSourceFile().fileName}:${node.getStart()}:${node.getEnd()}`;
  const typeCache = new Map<string, LayerInfo | undefined>();

  const infoOf = (node: ts.Node, inPipeContext: boolean): LayerInfo | undefined => {
    const cacheKey = `${keyOf(node)}:${inPipeContext}`;
    if (typeCache.has(cacheKey)) return typeCache.get(cacheKey);
    let type: Type | undefined;
    try {
      if (inPipeContext) {
        const contextual = checker.getContextualType(node as ts.Expression);
        const signatures = contextual ? checker.getSignaturesOfType(contextual, SignatureKind.Call) : [];
        if (signatures.length === 1) type = checker.getReturnTypeOfSignature(signatures[0]!);
      } else type = checker.getTypeAtLocation(node);
    } catch { type = undefined; }
    const channels = type ? layerChannels(type) : undefined;
    const info = channels ? {
      provides: channels.provides, requires: channels.requires,
      actualProvides: channels.provides.filter((provided) => !assignable(provided, channels.rIn)),
    } : undefined;
    typeCache.set(cacheKey, info);
    return info;
  };

  const parsePipe = (node: ts.Node): { subject: ts.Node; args: ts.Node[] } | undefined => {
    if (!isCall(node)) return undefined;
    const callee = node.expression;
    if (isPropertyAccess(callee) && callee.name.getText() === "pipe")
      return { subject: callee.expression, args: [...node.arguments] };
    if (isIdentifier(callee) && callee.getText() === "pipe" && isEffectPipe(callee) && node.arguments.length > 0)
      return { subject: node.arguments[0]!, args: [...node.arguments].slice(1) };
    return undefined;
  };
  const simpleName = (node: ts.Node): boolean => isIdentifier(node)
    || isPropertyAccess(node) && isIdentifier(node.name) && simpleName(node.expression);
  const aliased = (symbol: CompilerSymbol | undefined) =>
    symbol && symbol.flags & ALIAS ? checker.getAliasedSymbol(symbol) ?? symbol : symbol;
  /** The initializer a name's single declaration gives, when the checkout declares it. */
  const declarationOf = (node: ts.Node): ts.Expression | undefined => {
    let symbol: CompilerSymbol | undefined;
    try { symbol = aliased(checker.getSymbolAtLocation(node)); } catch { return undefined; }
    const declarations = symbol?.declarations ?? [];
    if (declarations.length !== 1 || !inRepo(declarations[0]!.path)) return undefined;
    return initializerOf(declarations[0]!.resolve(project));
  };

  /** One graph per root, as upstream extracts it; callers merge them by node key. */
  const extractCore = (root: ts.Node) => {
    const nodes = new Map<string, CompositionHolder>();
    const edges: CompositionEdge[] = [];
    const visited = new Set<string>();
    const inPipe = new Set<string>();
    const stack = [root];
    const add = (node: ts.Node, info: LayerInfo | undefined) => { nodes.set(keyOf(node), { node, info }); };
    const has = (node: ts.Node) => nodes.has(keyOf(node));
    const remove = (children: ReadonlyArray<ts.Node>) => {
      for (const child of children) {
        const key = keyOf(child);
        if (!nodes.delete(key)) continue;
        for (let i = edges.length - 1; i >= 0; i--) if (edges[i]!.from === key || edges[i]!.to === key) edges.splice(i, 1);
      }
    };
    const link = (from: ts.Node, to: ts.Node, relationship: CompositionRelationship, position?: number) =>
      edges.push({ from: keyOf(from), to: keyOf(to), relationship, ...(position === undefined ? {} : { index: position }) });
    while (stack.length > 0) {
      const current = stack.pop()!;
      const key = keyOf(current);
      // Static alternatives stay alternatives; configuration is never evaluated here.
      if (isConditional(current)) {
        const arms = [current.whenTrue, current.whenFalse];
        if (!visited.has(key)) { visited.add(key); stack.push(current, ...arms); }
        else {
          const info = infoOf(current, inPipe.has(key));
          if (info) { add(current, info); arms.forEach((arm, index) => { if (has(arm)) link(current, arm, "returned", index); }); }
        }
        continue;
      }
      const pipe = parsePipe(current);
      if (pipe) {
        if (!visited.has(key)) {
          stack.push(current, pipe.subject, ...pipe.args);
          for (const arg of pipe.args) inPipe.add(keyOf(arg));
          visited.add(key);
        } else {
          const children = [pipe.subject, ...pipe.args];
          if (children.every(has)) {
            for (let i = 1; i < children.length; i++) link(children[i]!, children[i - 1]!, "pipe");
            add(current, infoOf(current, inPipe.has(key)));
            link(current, children.at(-1)!, "pipe");
          } else {
            remove(children);
            const info = infoOf(current, inPipe.has(key));
            if (info) add(current, info);
          }
        }
        continue;
      }
      if (isCall(current)) {
        const args = [...current.arguments];
        if (!visited.has(key)) {
          stack.push(current, ...args);
          visited.add(key);
        } else if (args.length > 0 && args.every(has)) {
          add(current, infoOf(current, inPipe.has(key)));
          args.forEach((arg, position) => link(current, arg, "call", position));
        } else {
          const info = infoOf(current, inPipe.has(key));
          if (info) {
            // A library factory can take a Layer plus ordinary options. Keep
            // typed Layer arguments without claiming anything about its body.
            add(current, info);
            args.forEach((arg, position) => { if (has(arg)) link(current, arg, "call", position); });
          } else remove(args);
        }
        continue;
      }
      if (isArrayLiteral(current)) {
        const elements = [...current.elements];
        if (!visited.has(key)) {
          stack.push(current, ...elements);
          visited.add(key);
        } else {
          const present = elements.filter(has);
          if (present.length > 0) {
            add(current, infoOf(current, inPipe.has(key)));
            present.forEach((element, position) => link(current, element, "arrayLiteral", position));
          }
        }
        continue;
      }
      if (simpleName(current)) {
        const initializer = declarationOf(current);
        if (initializer) {
          if (!visited.has(key)) {
            stack.push(current, initializer);
            visited.add(key);
            continue;
          }
          if (has(initializer)) {
            add(current, infoOf(current, inPipe.has(key)));
            link(current, initializer, "symbol");
            continue;
          }
        }
      }
      const info = infoOf(current, inPipe.has(key));
      if (info) add(current, info);
    }
    return { nodes, edges };
  };

  // Supplemental links retain use sites. A factory definition is source evidence,
  // not an instantiated evaluation of its parameters.
  const returnsOf = (fn: ts.FunctionLikeDeclaration): ts.Node[] => {
    if (!fn.body) return [];
    if (!isBlock(fn.body)) return [fn.body];
    const found: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (functionLike(node)) return;
      if (isReturn(node)) { if (node.expression) found.push(node.expression); return; }
      node.forEachChild(visit);
    };
    fn.body.forEachChild(visit);
    return found;
  };
  const declarationNode = (node: ts.Node): ts.Node | undefined => {
    try {
      const declarations = aliased(checker.getSymbolAtLocation(node))?.declarations ?? [];
      return declarations.length === 1 && inRepo(declarations[0]!.path)
        ? declarations[0]!.resolve(project) : undefined;
    } catch { return undefined; }
  };
  const initializer = (node: ts.Node) => anyInitializer(declarationNode(node));
  const unwraps = (call: ts.CallExpression) => [...call.arguments].some((arg) => layerMember(arg) === "unwrap");
  const factoryReturns = (node: ts.Node): ts.Node[] => {
    const declaration = declarationNode(node);
    const fn = anyInitializer(declaration) ?? declaration;
    if (functionLike(fn)) return returnsOf(fn);
    // Effect.fn wrappers have a generator callback and a Layer.unwrap
    // transformation. Follow returned Layers without pretending to evaluate args.
    return isCall(fn) && unwraps(fn) ? generatorReturns(fn) : [];
  };
  const generatorReturns = (expression: ts.Node | undefined, seen = new Set<string>()): ts.Node[] => {
    if (!expression || seen.has(keyOf(expression))) return [];
    seen.add(keyOf(expression));
    if (functionLike(expression)) return returnsOf(expression);
    if (simpleName(expression)) return generatorReturns(initializer(expression), seen);
    // Follow only callbacks of this expression, never arbitrary nested functions.
    if (isCall(expression)) return [...expression.arguments].flatMap((argument) => functionLike(argument) ? returnsOf(argument) : []);
    return [];
  };
  const layerRequirements = (values: ReadonlyArray<ts.Node>) => values.flatMap((value) => infoOf(value, false)?.requires ?? []);
  const extract = (root: ts.Node) => {
    const result = extractCore(root);
    const queue = [...result.nodes.values()].map(({ node }) => node);
    const expanded = new Set<string>();
    const connect = (from: ts.Node, to: ts.Node, relationship: CompositionRelationship, index?: number) => {
      const addition = extractCore(to);
      if (!addition.nodes.has(keyOf(to))) return;
      for (const [key, value] of addition.nodes) if (!result.nodes.has(key)) {
        result.nodes.set(key, value); queue.push(value.node);
      }
      result.edges.push(...addition.edges, { from: keyOf(from), to: keyOf(to), relationship,
        ...(index === undefined ? {} : { index }) });
    };
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i]!, key = keyOf(node);
      if (expanded.has(key)) continue;
      expanded.add(key);
      if (!isCall(node)) continue;
      const member = layerMember(node.expression);
      const holder = result.nodes.get(key);
      if (!holder) continue;
      if (!member && !parsePipe(node)) {
        factoryReturns(node.expression).forEach((returned, index) => connect(node, returned, "factory", index));
        const fn = initializer(node.expression);
        if (isCall(fn) && unwraps(fn)) {
          holder.outerRequires = effectRequirements([...fn.arguments].find(functionLike));
          holder.returnedRequires = layerRequirements(generatorReturns(fn).filter((value) => infoOf(value, false)));
        }
      }
      if (member === "unwrap") {
        const effect = node.arguments[0];
        holder.outerRequires = effectRequirements(effect);
        const returned = generatorReturns(effect).filter((value) => infoOf(value, false));
        holder.returnedRequires = layerRequirements(returned);
        returned.forEach((value, index) => connect(node, value, "returned", index));
      }
      // Effect.fn(...)(function* ..., Layer.unwrap): callback return sites are
      // alternatives; index identifies the source arm, not an execution choice.
      if (unwraps(node)) {
        const returned = generatorReturns(node).filter((value) => infoOf(value, false));
        holder.outerRequires = effectRequirements(node);
        holder.returnedRequires = layerRequirements(returned);
        returned.forEach((value, index) => connect(node, value, "returned", index));
      }
      if (member === "effectContext") {
        const context = node.arguments[0];
        if (isPropertyAccess(context) && context.name.getText() === "contextEffect") {
          const runtime = initializer(context.expression);
          // The argument must be a resolved ManagedRuntime.make call. Supplied
          // by the probe, rather than trusting a spelling alone.
          if (isCall(runtime) && isManagedRuntimeMake(runtime.expression)) {
            holder.origin = "runtime-bridge";
            if (runtime.arguments[0]) connect(node, runtime.arguments[0], "runtime");
          }
        }
      }
      if (member === "succeed") {
        const value = node.arguments[1], binding = value && declarationNode(value);
        const yielded = anyInitializer(binding);
        if (binding && isYield(yielded) && yielded.asteriskToken) {
          let owner = binding.parent;
          while (owner && !functionLike(owner)) owner = owner.parent;
          const tag = yielded.expression;
          // Compare compiler symbols: same-named Tags are not interchangeable.
          let lexical: ts.Node | undefined = node.parent;
          while (lexical && (!owner || keyOf(lexical) !== keyOf(owner))) lexical = lexical.parent;
          if (owner && lexical && tag && node.arguments[0]
            && checker.getSymbolAtLocation(tag)?.id !== undefined
            && checker.getSymbolAtLocation(tag)?.id === checker.getSymbolAtLocation(node.arguments[0])?.id) {
            holder.origin = "ambient-instance";
            holder.ambientSource = { file: tag.getSourceFile().fileName, start: tag.getStart(), end: tag.getEnd() };
          }
        }
      }
    }
    const edges = [...new Map(result.edges.map((edge) => [
      `${edge.from}\0${edge.to}\0${edge.relationship}\0${edge.index ?? ""}`, edge])).values()];
    return { nodes: result.nodes, edges };
  };

  /** Which member of Effect's `Layer` module a call is (`provide`, `mergeAll`), by its resolved callee. */
  const combinatorOf = (node: ts.Node) => isCall(node) ? layerMember(node.expression) : undefined;
  return { extract, keyOf, combinatorOf };
};

const ALIAS = 2097152;
