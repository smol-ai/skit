import { resolve } from "node:path";
import { runtimeCalls } from "./graph-root.ts";
import * as ts from "./syntax.ts";
import type { GraphConventions } from "../conventions.ts";
import type { GraphEdge, GraphNode } from "./graph-artifact.ts";
import type { GraphBuilder } from "./graph-builder.ts";
import type { CompilerProgram, SourceProgram } from "./compiler-program.ts";

const callName = (expr: ts.Expression): string | null =>
  ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)
  && ts.isIdentifier(expr.expression.expression)
    ? `${expr.expression.expression.text}.${expr.expression.name.text}` : null;

/** A name in one module: a declared value, another module's export, or a namespace. */
export type Declaration =
  | { readonly kind: "value"; readonly node: ts.Node }
  | { readonly kind: "import"; readonly file: string; readonly name: string }
  | { readonly kind: "namespace"; readonly file: string }
  /** An import the archive cannot resolve; `name` is `*` for a namespace import. */
  | { readonly kind: "package"; readonly specifier: string; readonly name: string };

/** `Layer` or `Effect` from the effect package: its combinators and constants
 * compose an application but are not parts of it. In the canonical repository the
 * import resolves to that module's own source, which is still Effect's module. */
const effectModule = (declaration: Declaration | undefined): boolean =>
  declaration?.kind === "package" && (declaration.specifier === "effect" && (declaration.name === "Layer" || declaration.name === "Effect")
    || (declaration.specifier === "effect/Layer" || declaration.specifier === "effect/Effect") && declaration.name === "*")
  || declaration?.kind === "namespace" && /^packages\/effect\/src\/(?:Layer|Effect)\.ts$/.test(declaration.file);

export interface NameResolution {
  readonly resolveName: (fileName: string, name: string) => ts.Node | undefined;
  readonly resolveProperty: (expr: ts.PropertyAccessExpression) => ts.Node | undefined;
  readonly resolveValue: (expr: ts.Expression) => ts.Expression | undefined;
  readonly isImported: (fileName: string, name: string) => boolean;
  /** Whether a local name is Effect's own `Layer` or `Effect` module. */
  readonly isEffectModule: (fileName: string, name: string) => boolean;
  /** A namespace or named import from Effect's published packages, whose body is outside the archive. */
  readonly isEffectLibrary: (fileName: string, name: string) => boolean;
  readonly isEffectFunction: (fileName: string, name: string) => boolean;
  /** A `Module.member(...)` call, or a `Module.member` reference, named by what its module binds: `import { Layer as L } from "effect"`
   * makes `L.provide(...)` `Layer.provide`. Other modules keep the name written. */
  readonly callee: (expr: ts.Expression) => string | null;
  readonly moduleTarget: SourceProgram["moduleTarget"];
}

/** Resolve names across archived modules as the compiler bound them: top-level
 * declarations, named and namespace imports, re-exports, and bindings destructured
 * from a module namespace such as `const { Routes } = yield* Effect.promise(() => import("./routes"))`. */
/** An exported member of a namespace body, as `resolveName` gives a module's: a value's initializer, or the declaration. */
const namespaceMember = (namespace: ts.ModuleDeclaration, name: string): ts.Node | undefined => {
  const body = namespace.body;
  if (!body || !ts.isModuleBlock(body)) return undefined;
  const exported = (statement: ts.Statement) => ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  for (const statement of body.statements) {
    if (!exported(statement)) continue;
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations)
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer;
    if ((ts.isFunctionDeclaration(statement) && statement.body || ts.isClassDeclaration(statement)) && statement.name?.text === name) return statement;
    if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) && statement.name.text === name) return statement;
  }
  return undefined;
};

export const nameResolution = ({ program, declarations }: CompilerProgram): NameResolution => {
  const { repo, fileAt, moduleTarget } = program;
  const tableOf = declarations;
  const tableFor = (fileName: string): Map<string, Declaration> | undefined => {
    const file = fileAt(fileName);
    return file && tableOf(file);
  };
  const resolveName = (fileName: string, name: string, seen = new Set<string>()): ts.Node | undefined => {
    const key = `${fileName}\0${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const declaration = tableFor(fileName)?.get(name);
    if (declaration?.kind === "value") return declaration.node;
    if (declaration?.kind !== "import") return undefined;
    const target = fileAt(resolve(repo, declaration.file));
    return target && resolveName(target.fileName, declaration.name, seen);
  };
  const resolveProperty = (expr: ts.PropertyAccessExpression): ts.Node | undefined => {
    if (!ts.isIdentifier(expr.expression)) return undefined;
    const fileName = expr.getSourceFile().fileName;
    const namespace = tableFor(fileName)?.get(expr.expression.text);
    if (namespace?.kind === "namespace") {
      const target = fileAt(resolve(repo, namespace.file));
      // The member's own declaration, or the one it re-exports (`export { Widget } from "./widget"`).
      return target && resolveName(target.fileName, expr.name.text);
    }
    // A member of `export namespace Lifecycle { export const node = … }`, wherever the namespace is declared.
    const declared = resolveName(fileName, expr.expression.text);
    return declared && ts.isModuleDeclaration(declared) ? namespaceMember(declared, expr.name.text) : undefined;
  };
  const resolveValue = (expr: ts.Expression): ts.Expression | undefined => {
    if (ts.isIdentifier(expr)) {
      const value = resolveName(expr.getSourceFile().fileName, expr.text);
      return value && ts.isExpression(value) ? value : undefined;
    }
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
      const namespaceValue = resolveProperty(expr);
      if (namespaceValue && ts.isExpression(namespaceValue)) return namespaceValue;
      const resolved = resolveName(expr.getSourceFile().fileName, expr.expression.text);
      const value = resolved && ts.isExpression(resolved) ? resolved : undefined;
      const parent = value && ts.isAsExpression(value) ? value.expression : value;
      if (parent && ts.isObjectLiteralExpression(parent)) {
        const property = propertyValue(parent, expr.name.text);
        if (property) return property;
      }
    }
    return undefined;
  };
  const isImported = (fileName: string, name: string): boolean => tableFor(fileName)?.get(name)?.kind === "import";
  const isEffectModule = (fileName: string, name: string): boolean => effectModule(tableFor(fileName)?.get(name));
  const isEffectLibrary = (fileName: string, name: string): boolean => {
    const declaration = tableFor(fileName)?.get(name);
    return declaration?.kind === "package" && /^(?:effect(?:\/|$)|@effect\/)/.test(declaration.specifier);
  };
  const isEffectFunction = (fileName: string, name: string): boolean => {
    const declaration = tableFor(fileName)?.get(name);
    return declaration?.kind === "package" && (declaration.specifier === "effect" || declaration.specifier === "effect/Effect")
      && (declaration.name === "fn" || declaration.name === "fnUntraced");
  };
  const callee = (expr: ts.Expression): string | null => {
    // `Layer.launch(...)`, or a member passed by reference such as `pipe(NodeRuntime.runMain)`.
    const access = ts.isCallExpression(expr) ? expr.expression : expr;
    if (!ts.isPropertyAccessExpression(access) || !ts.isIdentifier(access.expression)) return null;
    const written = `${access.expression.text}.${access.name.text}`;
    const declaration = tableFor(access.getSourceFile().fileName)?.get(access.expression.text);
    if (declaration?.kind !== "package") return written;
    // `import * as L from "effect/Layer"` binds the module its path names; a named import binds its imported name.
    // Alchemy's split provider keeps the Cloudflare API identity under a lowercase package name.
    const module = declaration.name === "*" && declaration.specifier === "@alchemy.run/cloudflare" ? "Cloudflare"
      : declaration.name === "*" ? declaration.specifier.includes("/") ? declaration.specifier.slice(declaration.specifier.lastIndexOf("/") + 1) : undefined
      : declaration.name === "default" ? undefined : declaration.name;
    return module === undefined ? written : `${module}.${access.name.text}`;
  };
  return { resolveName, resolveProperty, resolveValue, isImported, isEffectModule, isEffectLibrary, isEffectFunction, callee, moduleTarget };
};

/** Called once for each expression the walker adds to a graph, with its node id. */
export type WalkHook = (expr: ts.Expression, id: string, builder: GraphBuilder) => void;

export interface CompositionWalk {
  /** Add `expr` to the graph, feeding `owner` through `relation`, and follow
   * what it is composed from. `expected` is the node kind where syntax alone
   * does not say whether a value is a Layer or an Effect. */
  readonly walk: (expr: ts.Expression, owner: string, relation: GraphEdge["kind"], expected?: GraphNode["kind"]) => void;
  /** An Effect pipe's subject and operations, as one node per step into `owner`. */
  readonly steps: (subject: ts.Expression, operations: ReadonlyArray<ts.Expression>, owner: string) => void;
  /** Make a local declaration visible to this walk, such as one earlier in
   * the function that contains a root. */
  readonly bind: (name: string, value: ts.Expression) => void;
  /** Make a declaration visible whose value another walk expands: a Worker
   * init's `const ports = …` is built at boot even where a handler uses it. */
  readonly bindElsewhere: (name: string, value: ts.Expression, walk: CompositionWalk["walk"]) => void;
  /** Expand a specialized composition boundary using this call's arguments,
   * with the same binding/context restoration as an ordinary helper call. */
  readonly inCall: (parameters: ReadonlyArray<ts.ParameterDeclaration>, call: ts.CallExpression, run: () => void) => void;
}

/** The value an object literal gives a property, written `name: value` or as the shorthand `{ name }`,
 * whose value is the variable of that name. */
export const propertyValue = (object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === name) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name) return property.name;
  }
  return undefined;
};

const optionOf = (call: ts.CallExpression, position: number, name: string): ReadonlyArray<ts.Expression> => {
  const options = call.arguments[position];
  const value = options && ts.isObjectLiteralExpression(options) ? propertyValue(options, name) : undefined;
  return value ? [value] : [];
};

/** The Layers an `Alchemy.Stack(name, { providers }, program)` call's options provide. */
export const stackProviders = (call: ts.CallExpression): ReadonlyArray<ts.Expression> => optionOf(call, 1, "providers");

/** The replacements a `LayerNode.compile(graph, { replacements })` call names. */
export const compileReplacements = (call: ts.CallExpression): ReadonlyArray<ts.Expression> => optionOf(call, 1, "replacements");

/** An expression's source text with every inline function's body shown as `{…}`:
 * `Effect.gen(function* () {…})` rather than the program written inside it. */
export const elidedText = (expr: ts.Node): string => {
  const file = expr.getSourceFile();
  const bodies: Array<readonly [number, number]> = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isBlock(node.body)) {
      bodies.push([node.body.getStart(file), node.body.getEnd()]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  let text = "";
  let at = expr.getStart(file);
  for (const [start, end] of bodies) { text += file.text.slice(at, start) + "{…}"; at = end; }
  return text + file.text.slice(at, expr.getEnd());
};

const cleanLabel = (text: string): string => text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ").slice(0, 120);
// A safety ceiling, rather than the normal stopping rule. Repeated call sites
// stop recursive expansion separately, so deep application wiring can be followed.
const MAX_DEPTH = 256;

/** One composition walk into `builder`. Bindings and call context are local to
 * the walk; name resolution and parsed sources are shared across walks. */
export const compositionWalk = (
  names: NameResolution,
  conventions: GraphConventions,
  builder: GraphBuilder,
  options: {
    readonly scope?: GraphNode["scope"]; readonly hooks?: ReadonlyArray<WalkHook>;
    /** Follow an Effect program through any call: a combinator with no rule of
     * its own, a helper, a function it cannot resolve, all compose their
     * arguments. A Worker's init needs this; a whole application server walked
     * this way reaches every library call it makes. */
    readonly followCalls?: boolean;
  } = {},
): CompositionWalk => {
  const { resolveName, resolveProperty, resolveValue, isImported, isEffectModule, isEffectLibrary, isEffectFunction, moduleTarget } = names;
  const opencode = conventions.frameworks.includes("opencode");
  const rootCalls = runtimeCalls(conventions);
  const hooks = options.hooks ?? [];
  const active = new Set<string>();
  // A node's id fixes its expression, kind and call context, and so the
  // bindings its subtree is walked with: once walked, it is complete.
  const walked = new Set<string>();
  const delegated = new Map<ts.Expression, CompositionWalk["walk"]>();
  // A declaration's value is evaluated where it is declared: walked in that call context, whichever use reaches it.
  const declaredIn = new Map<ts.Expression, string[]>();
  let resultBound: string | undefined;
  const bindings = new Map<string, ts.Expression>();
  // Functions being walked for a call, whose parameters the call binds.
  const calling = new Set<ts.Node>();
  const activeCallSites = new Set<ts.CallExpression>();
  const argumentBindings = new WeakMap<ts.Expression, { bindings: Map<string, ts.Expression>; context: string[] }>();
  const evaluatingArguments = new Set<ts.Expression>();
  // A helper body has one source span but can be expanded at several calls.
  // Keep those expansions distinct while evaluating arguments in their caller context.
  let callContext: string[] = [];
  const referencedNames = new WeakMap<ts.Expression, ReadonlyArray<string>>();
  const bindingKeys = new Map<string, string>();
  const bindingKey = (key: string): string => {
    let value = bindingKeys.get(key);
    if (value === undefined) { value = String(bindingKeys.size); bindingKeys.set(key, value); }
    return value;
  };
  // Resolve forwarded arguments in the environment where they were supplied.
  // Equal source arguments with different captured bindings must stay distinct.
  const argumentKey = (expr: ts.Expression, environment: Map<string, ts.Expression>, seen = new Set<ts.Expression>(),
    memo = new WeakMap<Map<string, ts.Expression>, Map<ts.Expression, string>>()): string => {
    const source = `${builder.location(expr).file}:${expr.getStart()}:${expr.getEnd()}`;
    if (seen.has(expr)) return bindingKey(JSON.stringify([source, "recursive", callContext]));
    let cached = memo.get(environment);
    if (!cached) { cached = new Map(); memo.set(environment, cached); }
    const existing = cached.get(expr);
    if (existing !== undefined) return existing;
    const next = new Set(seen).add(expr);
    const scope = environment;
    if (ts.isIdentifier(expr)) {
      const target = scope.get(expr.text);
      if (target && target !== expr) {
        const key = argumentKey(target, argumentBindings.get(target)?.bindings ?? scope, next, memo);
        cached.set(expr, key);
        return key;
      }
    }
    let names = referencedNames.get(expr);
    if (!names) {
      const found = new Set<string>();
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) found.add(node.text);
        ts.forEachChild(node, visit);
      };
      visit(expr);
      names = [...found].sort();
      referencedNames.set(expr, names);
    }
    const captured = names.flatMap((name) => {
      const value = scope.get(name);
      return value && value !== expr ? [[name, argumentKey(value, argumentBindings.get(value)?.bindings ?? scope, next, memo)]] : [];
    });
    // A local yielded resource is owned by its declaration's invocation.
    const declared = declaredIn.get(expr);
    const key = bindingKey(JSON.stringify([source, declared, captured]));
    cached.set(expr, key);
    return key;
  };
  const textHash = (text: string): string => {
    let hash = 0x811c9dc5;
    for (const character of text.replace(/\s+/g, " ")) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
    return hash.toString(16).padStart(8, "0");
  };
  const add = (source: ts.Node, kind: GraphNode["kind"], label: string): string => {
    const before = builder.size();
    // A long base keeps its `.pipe` suffix, so a pipe never reads as its own base.
    const clipped = label.endsWith(".pipe") && cleanLabel(label).length >= 120 ? `${cleanLabel(label.slice(0, -5)).slice(0, 114)}….pipe`
      : cleanLabel(label);
    const id = builder.node(source, { kind, label: clipped, ...(options.scope ? { scope: options.scope } : {}) },
      callContext.join("@"));
    // The first node a call's body adds is what it returns (or first yields).
    if (resultBound !== undefined) { builder.patch(id, { bound: resultBound }); resultBound = undefined; }
    if (builder.size() > before && ts.isExpression(source)) for (const hook of hooks) hook(source, id, builder);
    return id;
  };
  const unresolved = (id: string): void => builder.patch(id, { typeSource: "unresolved" });
  // What a name resolved to, or the name a call is made through.
  const refer = (id: string, name: ts.Expression, resolved: boolean): void => {
    const root = rootName(name);
    if (root === undefined) return;
    const fileName = name.getSourceFile().fileName;
    const declared = declaredInFunction(root);
    builder.patch(id, { reference:
      declared === "parameter" && isImported(fileName, root.text) ? "module"
      : declared ?? (isEffectModule(fileName, root.text) ? "effect"
        : resolved || bindings.has(root.text) ? "module" : "external") });
    if (!declared && !resolved && !bindings.has(root.text) && isEffectLibrary(fileName, root.text))
      builder.patch(id, { sourceBoundary: "library" });
  };
  const bindParameters = (parameters: ReadonlyArray<ts.ParameterDeclaration>, args: ReadonlyArray<ts.Expression>): Map<string, ts.Expression> => {
    const previous = new Map(bindings);
    parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) return;
      const name = parameter.name.text;
      const argument = args[index] ?? parameter.initializer;
      if (!argument) { bindings.delete(name); return; }
      if (args[index]) argumentBindings.set(argument, { bindings: previous, context: [...callContext] });
      if (ts.isIdentifier(argument) && argument.text === name) {
        const outer = previous.get(name);
        if (outer) bindings.set(name, outer);
        else bindings.delete(name);
      } else bindings.set(name, argument);
    });
    return previous;
  };
  const restoreBindings = (previous: Map<string, ts.Expression>): void => {
    bindings.clear();
    for (const [key, value] of previous) bindings.set(key, value);
  };
  // Bind a called function's parameters to the call's arguments and run its
  // expansion as a distinct expansion of that call site.
  const withCall = (parameters: ReadonlyArray<ts.ParameterDeclaration>, call: ts.CallExpression, run: () => void, id?: string, definition?: ts.Node): void => {
    // Node ids include caller contexts and therefore cannot themselves detect
    // recursive calls. The source call site is stable across those contexts.
    if (activeCallSites.has(call)) {
      if (id !== undefined) builder.patch(id, { extractionIssue: "recursive-call" });
      return;
    }
    activeCallSites.add(call);
    const previousContext = callContext;
    // A helper's definition belongs to its lexical owner, not every path that
    // reaches a call. Keep the call site and effective inputs, but do not copy
    // the complete transitive caller chain into every node in its body.
    let lexicalContext: string[] | undefined;
    let moduleDefinition = false;
    for (let at = definition; at; at = at.parent) {
      if (ts.isExpression(at) && declaredIn.has(at)) { lexicalContext = declaredIn.get(at); break; }
      if (at !== definition && ts.isFunctionLike(at)) break;
      if (ts.isSourceFile(at)) { lexicalContext = []; moduleDefinition = true; }
    }
    const inputKey = bindingKey(JSON.stringify(call.arguments.map((argument) => argumentKey(argument, bindings))));
    const previous = bindParameters(parameters, call.arguments);
    if (moduleDefinition && definition) {
      const own = new Set(parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
      // Known module declarations take precedence over unrelated caller names.
      // Keep forwarded argument aliases: their values are evaluated through the
      // saved caller environments, including unresolved host parameters.
      for (const name of bindings.keys()) if (!own.has(name)
        && resolveName(definition.getSourceFile().fileName, name)) bindings.delete(name);
    }
    callContext = [...(lexicalContext ?? previousContext), `${builder.location(call).file}:${call.getStart()}:${inputKey}`];
    // What the body returns is a value of what this call gave the parameters it reads
    // (`configured()` and `configured({ project: false })` are two Configs, however alike their subtrees).
    const body = parameters[0] && (parameters[0].parent as ts.SignatureDeclaration & { readonly body?: ts.Node }).body?.getText();
    const given = body ? parameters.flatMap((parameter, index) => ts.isIdentifier(parameter.name)
      && new RegExp(`\\b${parameter.name.text}\\b`).test(body)
      ? [`${parameter.name.text}=${call.arguments[index]?.getText() ?? ""}`] : []) : [];
    const previousPending = resultBound;
    resultBound = given.length > 0 ? textHash(given.join("\0")) : undefined;
    try { run(); } finally { restoreBindings(previous); callContext = previousContext; resultBound = previousPending; activeCallSites.delete(call); }
  };
  // Bind a block's local declarations, then walk what it returns. Callers
  // own restoring the bindings.
  const walkReturns = (body: ts.Block, owner: string, depth: number, expected: GraphNode["kind"]): void => {
    for (const statement of body.statements) if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)
        && declaration.initializer) {
        bindings.set(declaration.name.text, declaration.initializer);
        declaredIn.set(declaration.initializer, [...callContext]);
      }
    }
    // A generator's program is what it yields, in order, then what it returns.
    const generator = (ts.isFunctionExpression(body.parent) || ts.isFunctionDeclaration(body.parent)) && body.parent.asteriskToken;
    const yielded = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isYieldExpression(node) && node.asteriskToken && node.expression) walk(node.expression, owner, "uses", depth, "effect");
      ts.forEachChild(node, yielded);
    };
    // Statements in order, taking only the branch a literal-bound condition
    // selects (`if (graph === "query")` with graph "full"); a taken branch that
    // returns ends the body. Returns inside branches are followed too.
    const run = (statements: ReadonlyArray<ts.Statement>): boolean => {
      for (const statement of statements) {
        if (ts.isIfStatement(statement)) {
          const taken = truth(statement.expression);
          if (taken !== false && run(branchOf(statement.thenStatement)) && taken === true) return true;
          if (taken !== true && statement.elseStatement && run(branchOf(statement.elseStatement)) && taken === false) return true;
          continue;
        }
        if (ts.isReturnStatement(statement)) {
          if (statement.expression) walk(statement.expression, owner, "uses", depth, expected);
          return true;
        }
        if (generator) yielded(statement);
      }
      return false;
    };
    run(body.statements);
  };
  const branchOf = (statement: ts.Statement): ReadonlyArray<ts.Statement> => ts.isBlock(statement) ? statement.statements : [statement];
  /** The string a name holds where it is walked: a literal argument or default,
   * followed through the callers that bound it. */
  const literalOf = (expr: ts.Expression, scope: Map<string, ts.Expression> = bindings, hops = 0): string | undefined => {
    if (hops > 8) return undefined;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (ts.isParenthesizedExpression(expr)) return literalOf(expr.expression, scope, hops + 1);
    if (!ts.isIdentifier(expr)) return undefined;
    const bound = scope.get(expr.text);
    if (!bound || bound === expr) return undefined;
    return literalOf(bound, argumentBindings.get(bound)?.bindings ?? scope, hops + 1);
  };
  /** Whether a condition over literal-bound names is known to hold; undefined when it is not known. */
  const truth = (condition: ts.Expression): boolean | undefined => {
    if (ts.isParenthesizedExpression(condition)) return truth(condition.expression);
    if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = truth(condition.operand);
      return inner === undefined ? undefined : !inner;
    }
    if (!ts.isBinaryExpression(condition)) return undefined;
    const operator = condition.operatorToken.kind;
    const equal = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken;
    const unequal = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken;
    if (!equal && !unequal) return undefined;
    const left = literalOf(condition.left);
    const right = literalOf(condition.right);
    return left === undefined || right === undefined ? undefined : equal ? left === right : left !== right;
  };
  const walk = (expr: ts.Expression, owner: string, relation: GraphEdge["kind"], depth: number, expected: GraphNode["kind"]): void => {
    const caller = argumentBindings.get(expr);
    if (caller && !evaluatingArguments.has(expr)) {
      const previous = new Map(bindings);
      const previousContext = callContext;
      evaluatingArguments.add(expr);
      restoreBindings(caller.bindings);
      callContext = caller.context;
      try { walk(expr, owner, relation, depth, expected); }
      finally { restoreBindings(previous); callContext = previousContext; evaluatingArguments.delete(expr); }
      return;
    }
    if (ts.isParenthesizedExpression(expr)) return walk(expr.expression, owner, relation, depth, expected);
    if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr))
      return walk(expr.expression, owner, relation, depth, expected);
    // Dispatch by what the callee's module binds; label by what the source wrote.
    const name = names.callee(expr);
    // Effect's own modules settle the kind: a `Layer.*` call is a Layer even where a program expected an Effect.
    // A name bound to `yield* x` is what that Effect produced, wherever the name is written.
    const yielded = ts.isIdentifier(expr) && bindings.get(expr.text);
    const kind: GraphNode["kind"] = name?.startsWith("Effect.") || name?.endsWith(".runMain") ? "effect"
      : name?.startsWith("Layer.") ? "layer" : yielded && ts.isYieldExpression(yielded) ? "effect" : expected;
    const label = callName(expr) ?? (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)
      && expr.expression.name.text === "pipe" ? `${elidedText(expr.expression.expression)}.pipe`
      : elidedText(expr));
    const id = add(expr, kind, label);
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr))
      builder.patch(id, { body: ts.isFunctionExpression(expr) && expr.asteriskToken ? "generator" : "function" });
    if (yielded && ts.isYieldExpression(yielded)) builder.patch(id, { value: "yielded" });
    builder.edge(id, owner, relation, expr, ts.isArrowFunction(expr) || ts.isFunctionExpression(expr) ? "callback" : undefined);
    // A call of a name records what the callee resolved to; a pipe is a method of its base.
    if (ts.isCallExpression(expr) && (ts.isIdentifier(expr.expression)
      || ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text !== "pipe"))
      refer(id, expr.expression, resolveValue(expr.expression) !== undefined
        || ts.isPropertyAccessExpression(expr.expression) && resolveProperty(expr.expression) !== undefined);
    if (active.has(id)) { builder.patch(id, { extractionIssue: "recursive-call" }); return; }
    if (walked.has(id)) return;
    if (depth >= MAX_DEPTH) {
      builder.patch(id, { expansion: "depth-limit" });
      return;
    }
    active.add(id);
    const next = depth + 1;
    try {
      if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
        // `ticks.anomaly` where `ticks` is bound to an object literal at the call: that property's value.
        // The object a name holds, followed through names (`ticks` bound to `scheduledTicks`, a module object).
        const objectOf = (name: ts.Identifier): ts.Expression | undefined => {
          let value: ts.Expression | undefined = bindings.get(name.text);
          for (let hops = 0; value && ts.isIdentifier(value) && hops < 8; hops++) {
            const next = resolveValue(value);
            value = next && ts.isExpression(next) ? next : undefined;
          }
          return value;
        };
        const boundProperty = ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && bindings.has(expr.expression.text)
          ? objectOf(expr.expression) : undefined;
        const fromObject = boundProperty && ts.isObjectLiteralExpression(boundProperty)
          ? boundProperty.properties.find((property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
            (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
            && property.name.getText() === (expr as ts.PropertyAccessExpression).name.text) : undefined;
        const target = fromObject ? (ts.isPropertyAssignment(fromObject) ? fromObject.initializer
          : ts.isIdentifier(fromObject.name) ? fromObject.name : undefined)
          : ts.isIdentifier(expr) ? bindings.get(expr.text) ?? resolveValue(expr) : resolveValue(expr);
        const source = !target && ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)
          ? resolveName(expr.getSourceFile().fileName, expr.expression.text) : undefined;
        refer(id, expr, target !== undefined || source !== undefined);
        // A module name (not a binding of this call) is its declaration wherever it is written.
        const root = rootName(expr);
        const declared = fromObject || (ts.isIdentifier(expr) && bindings.has(expr.text)) || !root || declaredInFunction(root)
          ? undefined : target;
        if (declared) builder.patch(id, { declaration: builder.declaration(declared) });
        // A class it names (an alchemy Worker, `yield* Alerting`) is that declaration too, though not an expression to walk.
        const named = !declared && ts.isIdentifier(expr) && !bindings.has(expr.text) && !declaredInFunction(expr)
          ? resolveName(expr.getSourceFile().fileName, expr.text) : undefined;
        if (named && ts.isClassDeclaration(named)) builder.patch(id, { declaration: builder.declaration(named), reference: "module" });
        // What a parameter was given at this call: two expansions of one body differ where it does.
        if (target && (fromObject || ts.isIdentifier(expr) && bindings.get(expr.text) === target))
          builder.patch(id, { bound: textHash(target.getText()) });
        const elsewhere = target && delegated.get(target);
        const declaredContext = target && !fromObject ? declaredIn.get(target) : undefined;
        if (elsewhere) elsewhere(target, id, "uses", expected);
        else if (target && declaredContext) {
          const previousContext = callContext;
          callContext = declaredContext;
          try { walk(target, id, "uses", next, expected); } finally { callContext = previousContext; }
        } else if (target && declared) {
          // A module initializer is one value, not a fresh expansion for every
          // helper that references it. It cannot capture that helper's bindings.
          const previous = new Map(bindings);
          const previousContext = callContext;
          bindings.clear();
          callContext = [];
          try { walk(target, id, "uses", next, expected); }
          finally { restoreBindings(previous); callContext = previousContext; }
        } else if (target) walk(target, id, "uses", next, expected);
        else if (ts.isPropertyAccessExpression(expr) && expr.name.text === "contextEffect")
          walk(expr.expression, id, "uses", next, expected);
        else if (source && ts.isExpression(source)) walk(source, id, "uses", next, expected);
        else if (root && !declaredInFunction(root) && isEffectLibrary(expr.getSourceFile().fileName, root.text)) {
          builder.patch(id, { sourceBoundary: "library" });
        } else { unresolved(id); builder.patch(id, { extractionIssue: "unresolved-reference" }); }
      } else if (ts.isArrayLiteralExpression(expr)) {
        for (const item of expr.elements) if (ts.isExpression(item)) walk(item, id, "uses", next, expected);
      } else if (ts.isSpreadElement(expr)) {
        walk(expr.expression, id, "uses", next, expected);
      } else if (ts.isYieldExpression(expr) || ts.isAwaitExpression(expr)) {
        if (expr.expression) walk(expr.expression, id, "uses", next, expected);
      } else if (ts.isObjectLiteralExpression(expr)) {
        for (const property of expr.properties) if (ts.isPropertyAssignment(property)) {
          const propertyId = add(property, expected, property.name.getText());
          builder.edge(propertyId, id, "uses", property.initializer);
          walk(property.initializer, propertyId, "uses", next, expected);
        }
      } else if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        walk(expr.left, id, "branch", next, expected);
        walk(expr.right, id, "branch", next, expected);
      } else if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        const previous = new Map(bindings);
        // A callback's parameters are its own, not an outer binding of the same name; a function
        // walked for a call has its parameters bound to that call's arguments.
        if (!calling.has(expr)) for (const parameter of expr.parameters)
          if (ts.isIdentifier(parameter.name)) bindings.delete(parameter.name.text);
        try {
          if (ts.isExpression(expr.body)) walk(expr.body, id, "uses", next, expected);
          else walkReturns(expr.body, id, next, expected);
        } finally { restoreBindings(previous); }
      } else if (ts.isConditionalExpression(expr)) {
        const taken = truth(expr.condition);
        if (taken !== false) walk(expr.whenTrue, id, "branch", next, expected);
        if (taken !== true) walk(expr.whenFalse, id, "branch", next, expected);
      } else if (ts.isCallExpression(expr)) {
        walkCall(expr, name, id, next, expected);
      } else {
        unresolved(id);
        if (!ts.isLiteralExpression(expr) && ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(expr.kind))
          builder.patch(id, { extractionIssue: "unsupported-expression" });
      }
      walked.add(id);
    } finally { active.delete(id); }
  };
  /** The function created by Effect.fn, including its optional pipe steps.
   * Verify the import binding; an application's own `Effect.fn` is not this API. */
  const functionOf = (value: ts.Node | undefined): { fn: ts.ArrowFunction | ts.FunctionExpression; steps: ReadonlyArray<ts.Expression> } | undefined => {
    if (!value) return undefined;
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return { fn: value, steps: [] };
    if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) return functionOf(value.expression);
    if (!ts.isCallExpression(value)) return undefined;
    const callee = ts.isCallExpression(value.expression) ? value.expression.expression : value.expression;
    const effectFn = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
      && !declaredInFunction(callee.expression)
      && (callee.name.text === "fn" || callee.name.text === "fnUntraced")
      && isEffectModule(callee.getSourceFile().fileName, callee.expression.text)
      || ts.isIdentifier(callee) && !declaredInFunction(callee) && isEffectFunction(callee.getSourceFile().fileName, callee.text);
    const fn = value.arguments[0];
    return effectFn && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
      ? { fn, steps: value.arguments.slice(1) } : undefined;
  };
  const invoke = (target: NonNullable<ReturnType<typeof functionOf>>, expr: ts.CallExpression, id: string, next: number, expected: GraphNode["kind"]): void => {
    const { fn, steps } = target;
    builder.patch(id, { calls: builder.declaration(fn) });
    const wasCalling = calling.has(fn);
    calling.add(fn);
    try {
      withCall(fn.parameters, expr, () => steps.length
        ? walkEffectSteps(fn, steps, id, next)
        : walk(ts.isExpression(fn.body) ? fn.body : fn, id, "uses", next, expected), id, fn);
    } finally { if (!wasCalling) calling.delete(fn); }
  };
  const walkCall = (expr: ts.CallExpression, name: string | null, id: string, next: number, expected: GraphNode["kind"]): void => {
    const first = expr.arguments[0];
    if (name === "Layer.merge" || name === "Layer.mergeAll" || opencode && name === "LayerNode.group") {
      for (const arg of expr.arguments) {
        if (ts.isArrayLiteralExpression(arg)) for (const item of arg.elements) walk(item, id, "merge", next, "layer");
        else walk(arg, id, "merge", next, "layer");
      }
    } else if (opencode && name === "AppNodeBuilder.build"
      && (!ts.isPropertyAccessExpression(expr.expression) || !isFunction(resolveProperty(expr.expression)))) {
      for (const arg of expr.arguments) walk(arg, id, "uses", next, "layer");
    } else if (opencode && (name === "Runtime.run" || name === "Runtime.handlers")) {
      for (const arg of expr.arguments.slice(0, 2)) walk(arg, id, "uses", next, "effect");
    } else if (opencode && name === "Runtime.handler") {
      if (expr.arguments[1]) walk(expr.arguments[1], id, "uses", next, "effect");
    } else if (functionOf(expr)) {
      const target = functionOf(expr);
      if (target) {
        if (target.steps.length) walkEffectSteps(target.fn, target.steps, id, next);
        else walk(target.fn, id, "uses", next, "effect");
      }
    } else if (name === "Layer.effectDiscard" || name === "Layer.scopedDiscard" || name === "Layer.effectContext") {
      if (first) walk(first, id, "uses", next, "effect");
    } else if (name === "Alchemy.Stack") {
      // An alchemy stack deploys its program with the providers its options name.
      if (expr.arguments[2]) walk(expr.arguments[2], id, "uses", next, "effect");
      for (const providers of stackProviders(expr)) walk(providers, id, "provide", next, "layer");
    } else if (name === "Effect.provideService" && expr.arguments.length === 3 && first) {
      // Data-first `Effect.provideService(program, Tag, value)`: the program, given one service.
      walk(first, id, "uses", next, "effect");
    } else if (name === "Effect.acquireRelease") {
      if (first) walk(first, id, "acquire", next, "effect");
      if (expr.arguments[1]) walk(expr.arguments[1], id, "release", next, "effect");
    } else if (name === "Layer.unwrap" || name === "Effect.gen") {
      if (first) walk(first, id, "uses", next, name === "Effect.gen" ? "effect" : expected);
    } else if (name === "Layer.fresh" || name === "Layer.succeedContext") {
      // `Layer.succeedContext(context)` provides what built `context`, when the walk knows what that is.
      if (first) walk(first, id, "uses", next, "layer");
    } else if (name === "Command.run" || name === "Command.runWith" || name === "Command.withSubcommands"
      || name === "Command.withHandler" || name === "Command.make") {
      // A command remains a composition container even when its handler is opaque.
      if (name === "Command.make" || name === "Command.withSubcommands") builder.patch(id, { sourceRole: "command" });
      for (const arg of expr.arguments) {
        // A handler written inline (`Effect.fnUntraced(function* () {...})`) is walked like a named one.
        if (ts.isIdentifier(arg) || ts.isArrayLiteralExpression(arg) || ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
          || ts.isCallExpression(arg))
          walk(arg, id, "uses", next, name === "Command.make" || name === "Command.withHandler" ? "effect" : expected);
      }
    } else if (name === "Command.provide") {
      // A provider callback is constructed here, not a proven provider instance.
      builder.patch(id, { sourceRole: "command", extractionIssue: "unbound-callback" });
      for (const argument of expr.arguments) if (!ts.isObjectLiteralExpression(argument)) walk(argument, id, "uses", next, "effect");
    } else if (name === "Layer.provide" || name === "Layer.provideMerge" || name === "Effect.provide") {
      expr.arguments.forEach((arg, index) => {
        const provided = index === 0 && expr.arguments.length > 1;
        walk(arg, id, provided ? "uses" : name === "Layer.provideMerge" ? "provideMerge" : "provide", next,
          provided && name === "Effect.provide" ? "effect" : "layer");
      });
    } else if (opencode && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "replace") {
      walk(expr.expression.expression, id, "uses", next, "layer");
      if (first) walk(first, id, "replaces", next, "layer");
    } else if (name !== null && (rootCalls.has(name) || name === "HttpRouter.serve" || name.endsWith(".runMain"))) {
      if (first) walk(first, id, name === "Layer.launch" ? "launch" : "uses", next, name?.endsWith(".runMain") ? "effect" : "layer");
      if (name === "LayerNode.compile") walkReplacements(expr, id, next);
    } else if (ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "pipe" && expected === "effect"
      // A pipe of `Layer.*` operations is a Layer pipe, whatever the walk expected here.
      && !expr.arguments.some((operation) => ts.isCallExpression(operation) && names.callee(operation)?.startsWith("Layer."))) {
      walkEffectSteps(expr.expression.expression, expr.arguments, id, next);
    } else if (ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "pipe") {
      walk(expr.expression.expression, id, "uses", next, expected);
      for (const operation of expr.arguments) {
        const operationName = ts.isCallExpression(operation) ? names.callee(operation) : null;
        if (!ts.isCallExpression(operation)) {
          builder.patch(id, { extractionIssue: "opaque-call" });
          continue;
        }
        if (/^(?:(?:Layer|Effect)\.provide(?:Merge)?|HttpRouter\.provideRequest)$/.test(operationName ?? "") && operation.arguments[0])
          walk(operation.arguments[0], id, operationName === "Layer.provideMerge" ? "provideMerge" : "provide", next, "layer");
        else if (operationName === "Command.withSubcommands" || operationName === "Command.withHandler" || operationName === "Command.provide")
          walk(operation, id, "uses", next, "effect");
        else if (operationName === "Layer.flatMap" && operation.arguments[0]) {
          // The callback is given what the Layer built: a Layer it makes from that context
          // (`Layer.succeedContext(context)`) provides the Layer's services.
          const callback = operation.arguments[0];
          const given = (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.parameters[0] ? callback : undefined;
          const previous = given ? bindParameters([given.parameters[0]!], [expr.expression.expression]) : undefined;
          const wasCalling = given !== undefined && calling.has(given);
          if (given) calling.add(given);
          try { walk(callback, id, "uses", next, "layer"); }
          finally { if (given && !wasCalling) calling.delete(given); if (previous) restoreBindings(previous); }
        }
        // The Layer used instead when this one fails to build (`Layer.catchCause(() => local)`).
        else if (/^Layer\.(?:catchCause|catch|catchAll|catchTag|orElse)$/.test(operationName ?? "") && operation.arguments.at(-1))
          walk(operation.arguments.at(-1)!, id, "fallback", next, "layer");
        else builder.patch(id, { extractionIssue: "opaque-call" });
      }
    } else if (opencode && expr.expression.kind === ts.SyntaxKind.ImportKeyword && first && ts.isStringLiteral(first)) {
      // OpenCode lazily imports command handlers; the one that starts the server contributes its default export.
      const target = moduleTarget(expr.getSourceFile(), first.text);
      if (target && contains(target, (node) => ts.isCallExpression(node) && names.callee(node) === "ServerProcess.run")) {
        const exported = target.statements.find((statement): statement is ts.ExportAssignment =>
          ts.isExportAssignment(statement) && !statement.isExportEquals);
        if (exported) walk(exported.expression, id, "uses", next, "effect");
      }
    } else if (ts.isArrowFunction(expr.expression) || ts.isFunctionExpression(expr.expression)) {
      invoke({ fn: expr.expression, steps: [] }, expr, id, next, expected);
    } else if (ts.isPropertyAccessExpression(expr.expression) && functionOf(resolveValue(expr.expression))) {
      const target = functionOf(resolveValue(expr.expression));
      if (target) invoke(target, expr, id, next, expected);
    } else if (ts.isPropertyAccessExpression(expr.expression) && isFunction(resolveProperty(expr.expression))) {
      const named = resolveProperty(expr.expression) as ts.FunctionDeclaration;
      builder.patch(id, { calls: builder.declaration(named) });
      withCall(named.parameters, expr, () => walkReturns(named.body!, id, next, expected), id, named);
      // A helper's body need not return what it is handed (`Workers.cron(cron, onFire)` registers onFire).
      if (options.followCalls) for (const argument of expr.arguments)
        if (!ts.isLiteralExpression(argument) && !ts.isObjectLiteralExpression(argument)) walk(argument, id, "uses", next, expected);
    } else if (ts.isIdentifier(expr.expression)) {
      const named = resolveName(expr.getSourceFile().fileName, expr.expression.text);
      const target = bindings.get(expr.expression.text) ?? (named && ts.isExpression(named) ? named : undefined);
      const callable = functionOf(target);
      if (callable) {
        invoke(callable, expr, id, next, expected);
      } else if (isFunction(named)) {
        const body = named.body!;
        builder.patch(id, { calls: builder.declaration(named!) });
        withCall(named.parameters, expr, () => walkReturns(body, id, next, expected), id, named);
      } else if (target) walk(target, id, "uses", next, expected);
      else {
        unresolved(id);
        builder.patch(id, { extractionIssue: declaredInFunction(expr.expression) === "parameter" ? "unbound-callback" : "opaque-call" });
        // A call of a function the walker cannot resolve (a callback's `restore`) still composes its arguments.
        for (const argument of expr.arguments) if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
          || options.followCalls && !ts.isLiteralExpression(argument) && !ts.isObjectLiteralExpression(argument))
          walk(argument, id, "uses", next, expected);
      }
      // An imported helper's body cannot see what this call hands it.
      if (isImported(expr.getSourceFile().fileName, expr.expression.text))
        for (const argument of expr.arguments) if (options.followCalls
          ? !ts.isLiteralExpression(argument) && !ts.isObjectLiteralExpression(argument)
          : ts.isIdentifier(argument) || ts.isPropertyAccessExpression(argument) || ts.isArrayLiteralExpression(argument))
          walk(argument, id, "uses", next, expected);
    } else if (ts.isPropertyAccessExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)
      && !declaredInFunction(expr.expression.expression) && !bindings.has(expr.expression.expression.text)
      && isEffectLibrary(expr.getSourceFile().fileName, expr.expression.expression.text)) {
      // Direct Effect composition follows callbacks just as Effect pipe steps do.
      // This is structural containment; it does not say when a callback runs.
      for (const argument of expr.arguments) if (!ts.isLiteralExpression(argument) && !ts.isObjectLiteralExpression(argument))
        walk(argument, id, "uses", next, "effect");
    } else {
      unresolved(id);
      builder.patch(id, { extractionIssue: "opaque-call" });
      // Any other call (a library function, a curried `f(a)(b)`) composes its arguments and callee.
      if (options.followCalls) {
        if (ts.isCallExpression(expr.expression)) walk(expr.expression, id, "uses", next, expected);
        for (const argument of expr.arguments) if (!ts.isLiteralExpression(argument) && !ts.isObjectLiteralExpression(argument))
          walk(argument, id, "uses", next, expected);
      }
      else for (const argument of expr.arguments) if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
        walk(argument, id, "uses", next, expected);
    }
  };
  /** An Effect pipe as the steps it is: each operation is a node whose
   * compiler type is the Effect after it, so what `Effect.scoped` or
   * `Effect.provide(layer)` removes is read where it happens. */
  const walkEffectSteps = (subject: ts.Expression, operations: ReadonlyArray<ts.Expression>, id: string, next: number): void => {
    // Labelled as the walker labels the expression elsewhere: a call by its callee.
    const steps = operations.map((operation) => add(operation, "effect",
      ts.isCallExpression(operation) ? callName(operation) ?? operation.getText() : operation.getText()));
    walk(subject, steps[0] ?? id, "uses", next, "effect");
    operations.forEach((operation, index) => {
      builder.edge(steps[index]!, steps[index + 1] ?? id, "uses", operation);
      const operationName = ts.isCallExpression(operation) ? names.callee(operation) : null;
      if (!ts.isCallExpression(operation)) {
        const knownEffectStep = ts.isPropertyAccessExpression(operation) && ts.isIdentifier(operation.expression)
          && isEffectModule(operation.getSourceFile().fileName, operation.expression.text);
        if (!knownEffectStep) builder.patch(steps[index]!, { extractionIssue: "opaque-call" });
        return;
      }
      if (/^(?:(?:Layer|Effect)\.provide(?:Merge)?|HttpRouter\.provideRequest)$/.test(operationName ?? "") && operation.arguments[0])
        walk(operation.arguments[0], steps[index]!, operationName === "Layer.provideMerge" ? "provideMerge" : "provide", next, "layer");
      else if (operationName === "Command.withSubcommands" || operationName === "Command.withHandler" || operationName === "Command.provide")
        walk(operation, steps[index]!, "uses", next, "effect");
      // A step of Effect's own that sequences the program (`Effect.flatMap(() => Command.run(cli))`)
      // composes what its arguments hand it; with `followCalls`, any step does.
      else if (options.followCalls || operationName?.startsWith("Effect.")) {
        for (const argument of operation.arguments)
          if (!ts.isLiteralExpression(argument) && !ts.isObjectLiteralExpression(argument)) walk(argument, steps[index]!, "uses", next, "effect");
      }
      else builder.patch(steps[index]!, { extractionIssue: "opaque-call" });
    });
  };
  const walkReplacements = (compile: ts.CallExpression, id: string, next: number): void => {
    for (const replacements of compileReplacements(compile)) walk(replacements, id, "uses", next, "layer");
  };
  return {
    walk: (expr, owner, relation, expected = "layer") => walk(expr, owner, relation, 0, expected),
    steps: (subject, operations, owner) => walkEffectSteps(subject, operations, owner, 0),
    bind: (name, value) => { bindings.set(name, value); declaredIn.set(value, []); },
    bindElsewhere: (name, value, other) => { bindings.set(name, value); declaredIn.set(value, []); delegated.set(value, other); },
    inCall: withCall,
  };
};

/** Whether `name` is declared by a function enclosing it: a parameter, or a
 * variable in one of its blocks. The nearest declaration wins. */
const declaredInFunction = (name: ts.Identifier): "local" | "parameter" | undefined => {
  const binds = (binding: ts.BindingName): boolean => ts.isIdentifier(binding) ? binding.text === name.text
    : binding.elements.some((element) => !ts.isOmittedExpression(element) && element.name !== undefined && binds(element.name));
  for (let scope: ts.Node | undefined = name.parent; scope && !ts.isSourceFile(scope); scope = scope.parent) {
    if (ts.isBlock(scope) && !ts.isSourceFile(scope.parent) && scope.statements.some((statement) => ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some((declaration) => binds(declaration.name)))) return "local";
    if (ts.isFunctionLike(scope) && scope.parameters.some((parameter) => binds(parameter.name))) return "parameter";
  }
  return undefined;
};

/** The identifier a name starts from: `a` in `a.b.c`. */
const rootName = (expr: ts.Expression): ts.Identifier | undefined =>
  ts.isIdentifier(expr) ? expr : ts.isPropertyAccessExpression(expr) ? rootName(expr.expression) : undefined;
const isFunction = (node: ts.Node | undefined): node is ts.FunctionDeclaration =>
  node !== undefined && ts.isFunctionDeclaration(node) && node.body !== undefined;
const contains = (root: ts.Node, match: (node: ts.Node) => boolean): boolean => {
  let found = false;
  const visit = (node: ts.Node): void => { if (match(node)) found = true; if (!found) ts.forEachChild(node, visit); };
  visit(root);
  return found;
};
