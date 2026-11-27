import * as ts from "./syntax.ts";
import { relative, resolve } from "node:path";
import type { LayerGraph } from "./layer-graph.ts";
import type { SourceProgram } from "./compiler-program.ts";
import { graphBuilder } from "./graph-builder.ts";
import { compileReplacements, compositionWalk, propertyValue, stackProviders, type NameResolution, type WalkHook } from "./composition-walker.ts";
const stackLabel = (name: string): string => `Alchemy.Stack(${JSON.stringify(name)})`;
import { runsProgram, runtimeCalls, type GraphRoot, type RootCall } from "./graph-root.ts";
import type { GraphConventions } from "../conventions.ts";

export interface RuntimeGraph {
  readonly name: string;
  readonly entryFile: string;
  /** The function the runtime call is written in; absent at module level. */
  readonly within?: string;
  readonly instanceOf?: string;
  readonly root: GraphRoot;
  readonly graph: LayerGraph;
}

/** The function a node is written in, by the name the source gives it: a
 * function or method, the variable or property an arrow is assigned to
 * (`ServerFetch.make`), or for an anonymous callback the declaration it sits in.
 * Undefined at module level, including an `if (import.meta.main)` block. */
const enclosingFunction = (node: ts.Node): string | undefined => {
  let inside = false;
  for (let at: ts.Node | undefined = node.parent; at && !ts.isSourceFile(at); at = at.parent) {
    if (ts.isFunctionLike(at)) {
      inside = true;
      if (ts.isConstructorDeclaration(at) && ts.isClassLike(at.parent))
        return `${at.parent.name?.getText() ?? "an anonymous class"}.constructor`;
      const named = (ts.isFunctionDeclaration(at) || ts.isFunctionExpression(at) || ts.isMethodDeclaration(at)) && at.name
        ? at.name.getText() : undefined;
      if (named) {
        const owner = ts.isMethodDeclaration(at) && ts.isClassDeclaration(at.parent) ? at.parent.name?.getText() : undefined;
        return owner ? `${owner}.${named}` : named;
      }
    }
    if (!inside) continue;
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
    if (ts.isPropertyAssignment(at) || ts.isPropertyDeclaration(at)) {
      const property = at.name.getText();
      const object = ts.isPropertyAssignment(at) && ts.isObjectLiteralExpression(at.parent)
        && ts.isVariableDeclaration(at.parent.parent) && ts.isIdentifier(at.parent.parent.name) ? at.parent.parent.name.text
        : ts.isPropertyDeclaration(at) && ts.isClassDeclaration(at.parent) ? at.parent.name?.getText() : undefined;
      return object ? `${object}.${property}` : property;
    }
  }
  return inside ? "an anonymous function" : undefined;
};

/** Field initializers run during construction. Stop at a function body: a runtime
 * inside a field's callback runs when that callback is called instead. */
const enclosingInstance = (node: ts.Node): string | undefined => {
  for (let at = node.parent; at && !ts.isSourceFile(at); at = at.parent) {
    if (ts.isFunctionLike(at)) return undefined;
    if (ts.isPropertyDeclaration(at) && ts.isClassLike(at.parent)) {
      if (ts.getModifiers(at)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) return undefined;
      return at.parent.name?.getText() ?? "an anonymous class";
    }
  }
  return undefined;
};

const excluded = (path: string): boolean =>
  /(^|\/)(node_modules|repos|dist|generated|test|tests|fixture|fixtures|integration|__tests__|__fixtures__)(\/|$)/.test(path)
  || /(?:\.d|\.test|\.spec|\.integration)\.tsx?$/.test(path);

/** Syntax-backed runtime roots: each `Layer.launch`, `Layer.build`,
 * `ManagedRuntime.make`, `runMain` or typed `AtomRuntime` (and, for OpenCode,
 * `LayerNode.compile`) with the composition the walker follows from it. */
export const runtimeGraphs = (
  program: SourceProgram, names: NameResolution, conventions: GraphConventions, hooks: ReadonlyArray<WalkHook>,
): ReadonlyArray<RuntimeGraph> => {
  const { repo, fileAt } = program;
  const ROOT_CALLS = runtimeCalls(conventions);
  const isRootFile = (path: string): boolean => !excluded(relative(repo, path));
  const result: RuntimeGraph[] = [];
  // Declarations earlier in the block a call is written in, which it can refer to.
  const bindPreceding = (call: ts.Node, bind: (name: string, value: ts.Expression) => void): void => {
    let parent: ts.Node | undefined = call.parent;
    while (parent && !ts.isBlock(parent)) parent = parent.parent;
    if (parent && ts.isBlock(parent)) for (const statement of parent.statements) {
      if (statement.getStart() >= call.getStart()) break;
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) bind(declaration.name.text, declaration.initializer);
      }
    }
  };
  /** A runtime call whose Layer is a parameter of the named function it is written in, with that function's calls. */
  const wrapperOf = (root: ts.Node, input: ts.Expression) => {
    if (!ts.isIdentifier(input)) return undefined;
    let fn: ts.Node | undefined = root.parent;
    while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
    if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return undefined;
    const declared = fn;
    if (!declared.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === input.text)) return undefined;
    const name = ts.isFunctionDeclaration(declared) ? declared.name?.text
      : ts.isVariableDeclaration(declared.parent) && ts.isIdentifier(declared.parent.name) ? declared.parent.name.text : undefined;
    if (!name) return undefined;
    const sites: ts.CallExpression[] = [];
    for (const path of program.paths) {
      if (excluded(relative(repo, path)) || !program.textAt(path)!.includes(`${name}(`)) continue;
      const file = fileAt(path)!;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
          && names.resolveName(file.fileName, name) === declared) sites.push(node);
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    return { fn: declared, name, sites };
  };
  for (const path of program.paths) {
    if (!isRootFile(path)) continue;
    const file = fileAt(path)!;
    const entryFile = relative(repo, file.fileName);
    const roots: ts.CallExpression[] = [];
    const runMainStep = (node: ts.Node): RootCall | undefined => {
      const name = ts.isExpression(node) ? names.callee(node) : null;
      return runsProgram(name) ? name : undefined;
    };
    const atomRuntimeRoot = (node: ts.Node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node)
      && node.type !== undefined && /^Atom\.AtomRuntime(?:<|$)/.test(node.type.getText(file))
      && node.initializer !== undefined && ts.isCallExpression(node.initializer);
    const find = (node: ts.Node, parentRoot = false): void => {
      if (atomRuntimeRoot(node) && !parentRoot) {
        roots.push(node.initializer as ts.CallExpression);
        ts.forEachChild(node, (child) => find(child, true));
        return;
      }
      const callee = ts.isCallExpression(node) ? names.callee(node) : null;
      // `Alchemy.Stack("name", props, init)`; the class form's curried `Alchemy.Stack<Self>()` names no stack to follow.
      const isRoot = ts.isCallExpression(node) && (ROOT_CALLS.has(callee ?? "") && (callee !== "Alchemy.Stack" || node.arguments.length > 0)
        || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "pipe"
        && node.arguments.some((arg) => runMainStep(arg) !== undefined));
      if (isRoot && !parentRoot) roots.push(node);
      ts.forEachChild(node, (child) => find(child, parentRoot || isRoot));
    };
    find(file);
    for (const root of roots) {
      const typedAtomRuntime = ts.isVariableDeclaration(root.parent) && atomRuntimeRoot(root.parent);
      const written = names.callee(root);
      // A pipe ending in `NodeRuntime.runMain` is that runMain's root.
      const piped = written === null || !ROOT_CALLS.has(written);
      const call: RootCall = typedAtomRuntime ? "Atom.AtomRuntime"
        : piped ? root.arguments.map(runMainStep).find((step) => step !== undefined) ?? "NodeRuntime.runMain"
        : written as RootCall;
      const deployedAs = call === "Alchemy.Stack" && root.arguments[0] && ts.isStringLiteralLike(root.arguments[0])
        ? root.arguments[0].text : undefined;
      const declared = typedAtomRuntime ? root.parent.name.getText(file) : undefined;
      const label = declared !== undefined ? `${declared}: Atom.AtomRuntime` : deployedAs !== undefined ? stackLabel(deployedAs) : call;
      const described: GraphRoot = { call, ...(declared === undefined ? {} : { declared }), ...(deployedAs === undefined ? {} : { deployedAs }) };
      const atomOptions = root.arguments[0] && ts.isObjectLiteralExpression(root.arguments[0]) ? root.arguments[0] : undefined;
      const atomLayer = atomOptions && propertyValue(atomOptions, "layer");
      // `Atom.runtime({ layer })` or `Atom.runtime(layer)`.
      const rootInput = typedAtomRuntime ? atomLayer ?? (atomOptions ? undefined : root.arguments[0])
        : piped ? ts.isPropertyAccessExpression(root.expression) ? root.expression.expression : undefined
          : call === "Alchemy.Stack" ? root.arguments[2]
          : root.arguments[0];
      // `makeAppRuntime(layer, memoMap) => ManagedRuntime.make(layer, { memoMap })`: the Layer is each
      // caller's, so each call of the function is an entry, with its arguments bound.
      const wrapper = rootInput && !runsProgram(call) ? wrapperOf(root, rootInput) : undefined;
      if (wrapper && wrapper.sites.length > 0) {
        for (const site of wrapper.sites) {
          const siteFile = site.getSourceFile();
          const builder = graphBuilder(repo);
          const { walk, bind } = compositionWalk(names, conventions, builder, { hooks });
          const rootId = builder.node(site, { kind: "root", label: `${wrapper.name} → ${label}` });
          bindPreceding(site, bind);
          wrapper.fn.parameters.forEach((parameter, index) => {
            if (ts.isIdentifier(parameter.name) && site.arguments[index]) bind(parameter.name.text, site.arguments[index]!);
          });
          // The caller's argument is the Layer; the parameter it passes through is not a part.
          const position = wrapper.fn.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name)
            && parameter.name.text === (rootInput as ts.Identifier).text);
          const argument = site.arguments[position];
          if (argument) walk(argument, rootId, call === "Layer.launch" ? "launch" : "uses", "layer");
          const within = enclosingFunction(site);
          const instanceOf = enclosingInstance(site);
          const declared = ts.isVariableDeclaration(site.parent) && ts.isIdentifier(site.parent.name) ? `${site.parent.name.text} = ` : "";
          const siteEntry = relative(repo, siteFile.fileName);
          result.push({ name: `${siteEntry}:${builder.location(site).line} ${within ? `${within} → ` : ""}${declared}${wrapper.name} → ${label}`,
            entryFile: siteEntry, ...(within ? { within } : {}), ...(instanceOf ? { instanceOf } : {}),
            root: { ...described, through: wrapper.name }, graph: builder.graph() });
        }
        continue;
      }
      const builder = graphBuilder(repo);
      const { walk, bind, steps } = compositionWalk(names, conventions, builder, { hooks });
      const rootId = builder.node(root, { kind: "root", label });
      // Built inside a function: whatever it still needs, that function's callers supply.
      // The function callers name: an anonymous callback (`Effect.gen`'s generator) passes through to it.
      let enclosing: ts.Node | undefined = root.parent;
      while (enclosing && !(ts.isFunctionDeclaration(enclosing) || ts.isMethodDeclaration(enclosing)
        || (ts.isArrowFunction(enclosing) || ts.isFunctionExpression(enclosing))
          && (ts.isVariableDeclaration(enclosing.parent) || ts.isPropertyAssignment(enclosing.parent)))) enclosing = enclosing.parent;
      if (enclosing) builder.patch(rootId, { inside: builder.declaration(enclosing) });
      // A terminal inside a function can refer to declarations earlier in that function.
      bindPreceding(root, bind);
      // `program.pipe(Effect.scoped, Effect.provide(layer), NodeRuntime.runMain)`: the steps before runMain.
      if (rootInput && rootInput !== root.arguments[0] && runsProgram(call))
        steps(rootInput, root.arguments.filter((operation) => runMainStep(operation) === undefined), rootId);
      else if (rootInput) walk(rootInput, rootId, call === "Layer.launch" ? "launch" : "uses",
        runsProgram(call) || call === "Alchemy.Stack" ? "effect" : "layer");
      // An alchemy stack deploys its program with the providers its options name.
      if (call === "Alchemy.Stack") for (const providers of stackProviders(root)) walk(providers, rootId, "provide", "layer");
      if (call === "LayerNode.compile") for (const replacements of compileReplacements(root)) walk(replacements, rootId, "uses");
      const within = enclosingFunction(root);
      const instanceOf = enclosingInstance(root);
      result.push({ name: `${entryFile}:${builder.location(root).line} ${within ? `${within} → ` : ""}${label}`,
        entryFile, ...(within ? { within } : {}), ...(instanceOf ? { instanceOf } : {}), root: described, graph: builder.graph() });
    }
  }
  return result.sort((a, b) => a.entryFile.localeCompare(b.entryFile) || a.name.localeCompare(b.name));
};
