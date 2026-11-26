import { dirname, relative, resolve } from "node:path";
import * as ts from "./syntax.ts";
import type { GraphEdge, GraphNode, LayerGraph } from "./layer-graph.ts";
import type { GraphConventions } from "../conventions.ts";
import { graphBuilder, type GraphBuilder } from "./graph-builder.ts";
import { compositionWalk, elidedText, type CompositionWalk, type NameResolution, type WalkHook } from "./composition-walker.ts";
import type { SourceProgram } from "./compiler-program.ts";
import type { GraphRoot } from "./graph-root.ts";

export interface WorkerLayerGraph {
  readonly name: string;
  readonly entryFile: string;
  readonly root: GraphRoot;
  readonly graph: LayerGraph;
}

export interface WorkerSourceFile { readonly path: string; readonly text: string }

const visit = <T extends ts.Node>(start: ts.Node, predicate: (node: ts.Node) => node is T): T[] => {
  const found: T[] = [];
  const walk = (node: ts.Node): void => { if (predicate(node)) found.push(node); ts.forEachChild(node, walk); };
  walk(start);
  return found;
};

const workerCandidate = (path: string): boolean => /\.tsx?$/.test(path) && !/\.d\.ts$|\.test\.tsx?$|\.spec\.tsx?$/.test(path);

/** Recognize the actual Worker declaration, including a subclass built with
 * Cloudflare.Worker and a direct Cloudflare.Worker class expression. The label
 * keeps both identities: the class the source declares and the name it deploys. */
export const recognizeWorkerEntrypoint = (
  file: ts.SourceFile, names: NameResolution,
): { label: string; node: ts.ClassDeclaration; root: GraphRoot; factory: (node: ts.Node) => node is ts.CallExpression } | null => {
  const isWorkerFactory = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node) && names.callee(node) === "Cloudflare.Worker";
  for (const declaration of file.statements) {
    if (!ts.isClassDeclaration(declaration)) continue;
    const expression = declaration.heritageClauses?.flatMap((clause) => clause.types) ?? [];
    if (expression.some((type) => visit(type, isWorkerFactory).length > 0)) {
      const literal = expression.flatMap((type) => visit(type, (node): node is ts.StringLiteral => ts.isStringLiteral(node)))[0];
      const worker = `Cloudflare.Worker(${literal ? JSON.stringify(literal.text) : ""})`;
      const root: GraphRoot = { call: "Cloudflare.Worker", ...(declaration.name ? { declared: declaration.name.text } : {}),
        ...(literal ? { deployedAs: literal.text } : {}) };
      return { label: declaration.name ? `${declaration.name.text} · ${worker}` : worker, node: declaration, root, factory: isWorkerFactory };
    }
  }
  return null;
};

/** One graph per Cloudflare Worker, followed by data flow from its init: the
 * boot actions that run once per isolate and the handlers that run per event,
 * walked through the calls they make, and the Layers the init provides. A
 * Layer appears where the program composes it, never by proximity. */
export const workerGraphs = (
  program: SourceProgram, names: NameResolution, conventions: GraphConventions, hooks: ReadonlyArray<WalkHook>,
): ReadonlyArray<WorkerLayerGraph> => {
  const graphs: WorkerLayerGraph[] = [];
  for (const path of [...program.paths].sort((a, b) => a.localeCompare(b))) {
    if (!workerCandidate(path)) continue;
    const entry = program.fileAt(path)!;
    const worker = recognizeWorkerEntrypoint(entry, names);
    if (!worker) {
      // Local correction: Workers may export handlers directly, without an Alchemy class.
      for (const statement of entry.statements) {
        if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
        let object = statement.expression;
        if (!ts.isSatisfiesExpression(object) || !/\bExportedHandler\b/.test(object.type.getText())) continue;
        object = object.expression;
        if (!ts.isObjectLiteralExpression(object)) continue;
        const builder = graphBuilder(program.repo);
        const root = builder.node(statement, { kind: "root", label: "ExportedHandler", scope: "isolate" });
        const walk = compositionWalk(names, conventions, builder, { scope: "invocation", hooks, followCalls: true });
        handlersOf(object, root, builder, (expr, target, kind) => walk.walk(expr, target, kind, "effect"));
        const entryFile = relative(program.repo, entry.fileName);
        graphs.push({ name: `${entryFile}:${builder.location(statement).line} ExportedHandler`, entryFile,
          root: { call: "ExportedHandler" }, graph: builder.graph() });
      }
      continue;
    }
    const builder = graphBuilder(program.repo);
    const walks = new Map<GraphNode["scope"], ReturnType<typeof compositionWalk>>();
    // One walk per scope: what the isolate runs once and what each event runs.
    for (const scope of ["isolate", "invocation"] as const)
      walks.set(scope, compositionWalk(names, conventions, builder, { scope, hooks, followCalls: true }));
    const compose = (expr: ts.Expression, target: string, kind: GraphEdge["kind"], scope: GraphNode["scope"],
      expected: GraphNode["kind"] = "layer"): void => walks.get(scope)!.walk(expr, target, kind, expected);
    // The init's own declarations (`const onFire = …`) resolve wherever it uses them, and are
    // evaluated once, at boot: a handler that uses one reaches the isolate's.
    const bind = (name: string, value: ts.Expression): void => {
      walks.get("isolate")!.bind(name, value);
      walks.get("invocation")!.bindElsewhere(name, value, walks.get("isolate")!.walk);
    };
    const inCall: CompositionWalk["inCall"] = (parameters, call, run) =>
      walks.get("isolate")!.inCall(parameters, call, () => walks.get("invocation")!.inCall(parameters, call, run));
    const root = builder.node(worker.node, { kind: "root", label: worker.label, scope: "isolate" });
    const workerCall = visit(worker.node, (node): node is ts.CallExpression => ts.isCallExpression(node)
      && ts.isCallExpression(node.expression) && worker.factory(node.expression) && node.arguments.length >= 3)[0];
    const madeWorker = worker.node.name && visit(entry, (node): node is ts.CallExpression => ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === worker.node.name!.text && node.expression.name.text === "make"
      && node.arguments.length >= 2)[0];
    const init = workerCall?.arguments[2] ?? madeWorker?.arguments[1];
    // The init is followed by data flow: its boot actions and handlers are
    // walked like any Effect, so a Layer appears where the program composes it.
    if (init) bootGraph(init, root, builder, compose, bind, names, inCall);
    else {
      // No init: the Worker runs the module its props name as `main`, whose default export holds the handlers.
      const main = mainModule(program, entry, worker.node);
      const exported = main?.statements.find((statement): statement is ts.ExportAssignment =>
        ts.isExportAssignment(statement) && !statement.isExportEquals);
      if (exported && ts.isObjectLiteralExpression(exported.expression)) handlersOf(exported.expression, root, builder, compose);
    }
    const entryFile = relative(program.repo, entry.fileName);
    graphs.push({ name: `${entryFile}:${builder.location(worker.node).line} ${worker.label}`, entryFile, root: worker.root, graph: builder.graph() });
  }
  return graphs;
};

/** The module a Worker's props name as `main` (`${import.meta.dirname}/src/worker.ts`), when the
 * source writes it as a path relative to the Worker's own file. */
const mainModule = (program: SourceProgram, entry: ts.SourceFile, worker: ts.ClassDeclaration): ts.SourceFile | undefined => {
  const props = visit(worker, (node): node is ts.Identifier => ts.isIdentifier(node) && node.text === "props").length > 0
    ? entry : worker;
  const main = visit(props, (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && node.name.getText() === "main")[0];
  const text = main && (ts.isNoSubstitutionTemplateLiteral(main.initializer) || ts.isStringLiteral(main.initializer)
    ? main.initializer.text : ts.isTemplateExpression(main.initializer) && main.initializer.head.text === ""
      && main.initializer.templateSpans.length === 1 && main.initializer.templateSpans[0]!.expression.getText() === "import.meta.dirname"
      ? `.${main.initializer.templateSpans[0]!.literal.text}` : undefined);
  if (!text) return undefined;
  return program.fileAt(resolve(dirname(entry.fileName), text));
};

/** A handlers object: each property runs per event, walked from its implementation. */
const handlersOf = (
  object: ts.ObjectLiteralExpression, root: string, builder: GraphBuilder,
  compose: (expr: ts.Expression, target: string, kind: GraphEdge["kind"], scope: GraphNode["scope"], expected?: GraphNode["kind"]) => void,
): void => {
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) continue;
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
    if (!name || !property.name) continue;
    const handler = builder.node(property.name, { kind: "effect", label: `${name} handler`, scope: "invocation", sourceRole: "handler" });
    builder.edge(handler, root, "uses", property);
    const implementation = ts.isPropertyAssignment(property) ? property.initializer
      : ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name) ? property.name
      : ts.isMethodDeclaration(property) && property.body ? property.body.statements.find(ts.isReturnStatement)?.expression : undefined;
    if (implementation) compose(implementation, handler, "uses", "invocation", "effect");
  }
};

/** The Worker's init: an `Effect.gen` whose statements run once per isolate
 * and whose returned object holds the event handlers, or `Effect.succeed` of
 * the handlers alone. Each handler runs per event; Layers the init provides
 * feed the Worker. */
const bootGraph = (
  init: ts.Expression, root: string, builder: GraphBuilder,
  compose: (expr: ts.Expression, target: string, kind: GraphEdge["kind"], scope: GraphNode["scope"], expected?: GraphNode["kind"]) => void,
  bind: (name: string, value: ts.Expression) => void,
  names: NameResolution,
  inCall: CompositionWalk["inCall"],
  ancestors: ReadonlySet<ts.Expression> = new Set(),
): void => {
  if (ancestors.has(init)) { compose(init, root, "uses", "isolate", "effect"); return; }
  const nested = new Set([...ancestors, init]);
  const call = (node: ts.Node, name: string): node is ts.CallExpression => ts.isCallExpression(node) && names.callee(node) === name;
  let effect = init;
  let owner = root;
  const aliases = new Set<ts.Expression>();
  const provided: ts.Expression[] = [];
  // A named initializer is the same program as an inline one. Keep its source
  // identity and follow imported aliases, without sweeping unrelated module code.
  for (;;) {
    if (aliases.has(effect)) break;
    aliases.add(effect);
    if (ts.isParenthesizedExpression(effect) || ts.isAsExpression(effect) || ts.isSatisfiesExpression(effect)
      || ts.isNonNullExpression(effect)) { effect = effect.expression; continue; }
    if (ts.isCallExpression(effect) && ts.isPropertyAccessExpression(effect.expression) && effect.expression.name.text === "pipe") {
      for (const operation of effect.arguments)
        if (call(operation, "Effect.provide") && operation.arguments[0]) provided.push(operation.arguments[0]);
      effect = effect.expression.expression;
      continue;
    }
    if (!ts.isIdentifier(effect) && !ts.isPropertyAccessExpression(effect)) break;
    const value = names.resolveValue(effect);
    if (!value || value === effect) break;
    if (owner === root) {
      owner = builder.node(init, { kind: "effect", label: init.getText(), scope: "isolate", reference: "module",
        declaration: builder.declaration(value) });
      builder.edge(owner, root, "uses", init);
    }
    effect = value;
  }
  const bootAction = (expr: ts.Expression): void => {
    const actual = ts.isYieldExpression(expr) && expr.expression ? expr.expression : expr;
    compose(actual, owner, "uses", "isolate", "effect");
  };
  // A returned factory's success value is the Worker's handlers too. Follow only
  // the actual return chain, in the call's bindings; ordinary yielded helpers
  // stay ordinary boot actions and cannot invent handler lifetimes.
  const bootReturn = (expr: ts.Expression): void => {
    const actual = ts.isYieldExpression(expr) && expr.expression ? expr.expression : expr;
    if (ts.isCallExpression(actual)) {
      const fn = names.resolveValue(actual.expression)
        ?? (ts.isIdentifier(actual.expression) ? names.resolveName(actual.getSourceFile().fileName, actual.expression.text)
          : ts.isPropertyAccessExpression(actual.expression) ? names.resolveProperty(actual.expression) : undefined);
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) && fn.body) {
        const returns = ts.isBlock(fn.body) ? fn.body.statements.filter(ts.isReturnStatement) : [];
        const returned = ts.isExpression(fn.body) ? fn.body : returns.length === 1 ? returns[0]!.expression : undefined;
        if (returned && !nested.has(returned)) {
          const called = builder.node(actual, { kind: "effect", label: elidedText(actual), scope: "isolate",
            reference: "module", calls: builder.declaration(fn) });
          builder.edge(called, owner, "uses", actual);
          inCall(fn.parameters, actual, () => bootGraph(returned, called, builder, compose, bind, names, inCall, nested));
          return;
        }
      }
    }
    bootAction(actual);
  };
  const handlers = (object: ts.ObjectLiteralExpression): void => handlersOf(object, owner, builder, compose);
  const bootStatement = (statement: ts.Statement): void => {
    if (ts.isExpressionStatement(statement)) bootAction(statement.expression);
    else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      // Only what the init yields runs at boot; `const x = f()` declares a value it may use later.
      if (declaration.initializer && ts.isYieldExpression(declaration.initializer)) bootAction(declaration.initializer);
    } else if (ts.isReturnStatement(statement) && statement.expression) {
      if (ts.isObjectLiteralExpression(statement.expression)) handlers(statement.expression);
      else bootReturn(statement.expression);
    }
  };
  const body = call(effect, "Effect.gen") ? effect.arguments[0] : undefined;
  if (body && ts.isFunctionExpression(body) && body.asteriskToken) builder.patch(owner, { body: "generator" });
  if (body && (ts.isFunctionExpression(body) || ts.isArrowFunction(body)) && ts.isBlock(body.body))
    for (const statement of body.body.statements) if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer) bind(declaration.name.text, declaration.initializer);
  if (body && (ts.isFunctionExpression(body) || ts.isArrowFunction(body)) && ts.isBlock(body.body)) {
    for (const statement of body.body.statements) {
      if (ts.isForOfStatement(statement) && ts.isBlock(statement.statement))
        for (const nested of statement.statement.statements) bootStatement(nested);
      else bootStatement(statement);
    }
  }
  const succeeded = call(effect, "Effect.succeed") ? effect.arguments[0] : undefined;
  if (succeeded && ts.isObjectLiteralExpression(succeeded)) handlers(succeeded);
  // Handlers named elsewhere (`Effect.succeed(handlers)`) are followed to what they are.
  else if (succeeded) compose(succeeded, owner, "uses", "invocation", "effect");
  // Unsupported initializer shapes still retain their actual data flow and facts.
  else if (!body) bootReturn(effect);
  for (const layer of provided) compose(layer, owner, "provide", "isolate");
};
