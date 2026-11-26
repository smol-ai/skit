import * as ts from "./syntax.ts";
import type { GraphConventions } from "../conventions.ts";
import type { NameResolution, WalkHook } from "./composition-walker.ts";

/** What an imported name declares, as the compiler bound it through any re-exports:
 * a class, or a function (declared, or an arrow function a variable holds). */
const importedClass = (names: NameResolution, file: ts.SourceFile, name: string): ts.ClassDeclaration | undefined => {
  const declared = names.isImported(file.fileName, name) ? names.resolveName(file.fileName, name) : undefined;
  return declared && ts.isClassDeclaration(declared) ? declared : undefined;
};
const importedFunction = (names: NameResolution, file: ts.SourceFile, name: string): ts.FunctionDeclaration | ts.ArrowFunction | undefined => {
  const declared = names.isImported(file.fileName, name) ? names.resolveName(file.fileName, name) : undefined;
  return declared && (ts.isFunctionDeclaration(declared) || ts.isArrowFunction(declared)) ? declared : undefined;
};

/** Source Layer contracts: a call `make()` to an imported function declared to
 * return `Layer.Layer<Out, E, In>`, and `Service.layer` for an imported
 * `Context.Service` class whose static `layer` is `Layer.effect(...)`. This is
 * syntax only; it does not infer instantiated service unions. */
export const sourceLayerContracts = (names: NameResolution): WalkHook => {
  const requirements = (declaration: ts.ClassDeclaration, layer: ts.PropertyDeclaration): ReadonlyArray<ts.Expression> => {
    const found: ts.Expression[] = [];
    const file = declaration.getSourceFile();
    const visit = (node: ts.Node): void => {
      if (ts.isYieldExpression(node) && node.asteriskToken && node.expression) {
        const yielded = node.expression;
        if (ts.isPropertyAccessExpression(yielded) && ts.isIdentifier(yielded.expression)
          && yielded.expression.text === yielded.name.text) found.push(yielded);
        else if (ts.isIdentifier(yielded)) {
          const service = importedClass(names, file, yielded.text);
          if (service?.heritageClauses?.some((clause) => clause.types.some((type) => ts.isExpressionWithTypeArguments(type)
            && type.expression.getText(service.getSourceFile()).includes("Context.Service")))) found.push(yielded);
        }
      }
      ts.forEachChild(node, visit);
    };
    const initializer = layer.initializer;
    if (initializer && ts.isCallExpression(initializer)) {
      const maker = initializer.arguments[1];
      if (maker && ts.isPropertyAccessExpression(maker) && maker.name.text === "make"
        && (maker.expression.kind === ts.SyntaxKind.ThisKeyword
          || ts.isIdentifier(maker.expression) && maker.expression.text === declaration.name?.text)) {
        for (const heritage of declaration.heritageClauses ?? []) visit(heritage);
      } else if (maker) visit(maker);
    }
    return found;
  };
  return (expr, id, builder) => {
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.arguments.length === 0) {
      const name = expr.expression.text;
      const declared = importedFunction(names, expr.getSourceFile(), name);
      const returnType = declared?.type;
      if (!returnType || !ts.isTypeReferenceNode(returnType) || returnType.typeName.getText() !== "Layer.Layer"
        || returnType.typeArguments?.length !== 3) return;
      const definition = builder.node(returnType, { kind: "layer", label: `${name}: ${returnType.getText()}` });
      builder.edge(definition, id, "uses", returnType);
      for (const [index, kind] of [[0, "provides"], [2, "requires"]] as const) {
        const type = returnType.typeArguments[index]!;
        builder.edge(builder.node(type, { kind: "service", label: type.getText() }), definition, kind, type);
      }
      return;
    }
    if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== "layer") return;
    const target = expr.expression;
    const member = ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) ? names.resolveProperty(target) : undefined;
    const service = ts.isIdentifier(target) ? importedClass(names, expr.getSourceFile(), target.text)
      : member && ts.isClassDeclaration(member) ? member : undefined;
    const staticLayer = service?.members.find((member): member is ts.PropertyDeclaration => ts.isPropertyDeclaration(member)
      && member.name.getText() === "layer" && (ts.getModifiers(member)?.some((item) => item.kind === ts.SyntaxKind.StaticKeyword) ?? false));
    const initializer = staticLayer?.initializer;
    if (!service || !staticLayer || !initializer || !ts.isCallExpression(initializer)
      || initializer.expression.getText() !== "Layer.effect") return;
    const layer = builder.node(initializer, { kind: "layer", label: `${service.name!.text}.layer = Layer.effect(...)` });
    builder.edge(layer, id, "uses", initializer);
    for (const required of requirements(service, staticLayer))
      builder.edge(builder.node(required, { kind: "service", label: required.getText() }), layer, "requires", required);
  };
};

/** OpenCode `LayerNode`s: follow `X.node` to its authored `makeGlobalNode`,
 * `makeLocationNode`, `LayerNode.make` or `LayerNode.unbound` definition,
 * record its scope, and add its declared `deps` as requirements. Names resolve
 * as the compiler binds them, through imports, re-exports and namespaces. */
export const layerNodeDependencies = (names: NameResolution): WalkHook => {
  const initializer = (statements: ts.NodeArray<ts.Statement>, name: string): ts.Expression | undefined => {
    for (const statement of statements) if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)
        && declaration.name.text === name) return declaration.initializer;
    }
    return undefined;
  };
  const DEFINITIONS = /^(?:makeGlobalNode|makeLocationNode|Node\.makeGlobalNode|Node\.makeLocationNode|LayerNode\.make|LayerNode\.unbound)$/;
  /** The definition call a node's value is, directly or returned by the factory it calls. */
  const definition = (expr: ts.Expression, depth = 0): ts.CallExpression | undefined => {
    if (depth > 4 || !ts.isCallExpression(expr)) return undefined;
    const callee = expr.expression.getText();
    if (DEFINITIONS.test(callee)) return expr;
    // A factory called by name (`configured(options)`) or through its module (`Database.configured(options)`).
    const factory = ts.isIdentifier(expr.expression) ? names.resolveName(expr.getSourceFile().fileName, callee)
      : ts.isPropertyAccessExpression(expr.expression) && ts.isIdentifier(expr.expression.expression) ? names.resolveProperty(expr.expression)
      : undefined;
    if (!factory || !(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory) || ts.isFunctionDeclaration(factory)) || !factory.body) return undefined;
    if (!ts.isBlock(factory.body)) return definition(factory.body, depth + 1);
    for (const statement of factory.body.statements) if (ts.isReturnStatement(statement) && statement.expression)
      return definition(statement.expression, depth + 1);
    return undefined;
  };
  const authoredNode = (value: ts.Expression)
    : { call: ts.CallExpression; deps: ReadonlyArray<ts.Expression>; value: ts.Expression } | undefined => {
    const call = definition(value);
    if (!call) return undefined;
    if (call.expression.getText() === "LayerNode.unbound") return { call, deps: [], value };
    const options = call.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
    const property = options.properties.find((item) => (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item))
      && item.name.getText() === "deps");
    if (!property) return { call, deps: [], value };
    // `{ deps }` names the array as a variable; `{ deps: [...] }` gives it inline.
    const named = ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
    if (named && !ts.isIdentifier(named)) return { call, deps: [], value };
    let deps: ts.Expression = named ?? (property as ts.PropertyAssignment).initializer;
    if (ts.isIdentifier(deps)) {
      // A named array declared in the namespace or module that defines the node.
      let scope: ts.Node = call;
      while (!ts.isModuleBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      const named = initializer(scope.statements, deps.text) ?? initializer(call.getSourceFile().statements, deps.text);
      if (!named) return undefined;
      deps = named;
    }
    if (ts.isAsExpression(deps) || ts.isSatisfiesExpression(deps)) deps = deps.expression;
    return ts.isArrayLiteralExpression(deps) ? { call, deps: deps.elements.filter(ts.isExpression), value } : undefined;
  };
  const nodeReference = (expr: ts.Expression): string | undefined =>
    ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.name.text === "node" ? expr.expression.text : undefined;
  return (expr, id, builder) => {
    const visited = new Set<string>();
    const authoredFor = (reference: ts.Expression) => {
      // A factory's call is its own value: `Database.configured(options)` returns the node it defines.
      if (ts.isCallExpression(reference)) return authoredNode(reference);
      if (!nodeReference(reference) && !ts.isIdentifier(reference)) return undefined;
      const value = names.resolveValue(reference);
      return value && authoredNode(value);
    };
    const expand = (reference: ts.Expression, owner: string): void => {
      const authored = authoredFor(reference);
      if (!authored) return;
      const callee = authored.call.expression.getText();
      const unbound = callee === "LayerNode.unbound";
      const scopeArgument = authored.call.arguments[1];
      const scope = callee.endsWith("makeGlobalNode") ? "global" as const
        : callee.endsWith("makeLocationNode") ? "location" as const
        : unbound && scopeArgument && ts.isPropertyAccessExpression(scopeArgument)
          && (scopeArgument.name.text === "global" || scopeArgument.name.text === "location") ? scopeArgument.name.text : undefined;
      if (scope || unbound) builder.patch(owner, { ...(scope ? { scope } : {}), ...(unbound ? { binding: "unbound" as const } : {}) });
      if (unbound) builder.edge(builder.node(authored.call, { kind: "service", label: authored.call.getText(),
        binding: "unbound", ...(scope ? { scope } : {}) }), owner, "uses", authored.call);
      const key = `${authored.call.getSourceFile().fileName}\0${owner}`;
      if (visited.has(key)) return;
      visited.add(key);
      for (const dependency of authored.deps) {
        const declared = authoredFor(dependency);
        const dependencyId = builder.node(dependency, { kind: "layer", label: dependency.getText(),
          ...(nodeReference(dependency) || declared ? { reference: "module" as const } : {}),
          ...(declared ? { declaration: builder.declaration(declared.value) } : {}) });
        builder.edge(dependencyId, owner, "requires", dependency);
        expand(dependency, dependencyId);
      }
    };
    expand(expr, id);
  };
};

/** The hooks every composition walk applies for a pin's conventions. */
export const compositionHooks = (names: NameResolution, conventions: GraphConventions): ReadonlyArray<WalkHook> => [
  ...(conventions.frameworks.includes("opencode") ? [layerNodeDependencies(names)] : []),
  sourceLayerContracts(names),
];
