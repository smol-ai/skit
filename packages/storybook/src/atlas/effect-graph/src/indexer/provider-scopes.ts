import * as ts from "./syntax.ts";
import type { CompilerProgram } from "./compiler-program.ts";
import { nameResolution } from "./composition-walker.ts";
import { resolve } from "node:path";

/** Bound provider expressions and source returns. Arguments are not evaluated. */
export const providerScopes = (compiled: CompilerProgram, entries: ReadonlyArray<string>, scopes: ReadonlyArray<{file: string; span: readonly [number, number]; graphNodeId: string}>) => {
  const names = nameResolution(compiled), queries: Array<{file: string; line: number; column: number; span: readonly [number, number]; graphNodeId: string; name: string}> = [];
  const query = (node: ts.Expression) => {
    const file = node.getSourceFile(), start = node.getStart(file), at = file.getLineAndCharacterOfPosition(start);
    const row = { file: file.fileName, line: at.line + 1, column: at.character + 1, span: [start, node.getEnd()] as const,
      graphNodeId: `provider-scope:${file.fileName}:${start}`, name: node.getText(file) };
    if (!queries.some(item => item.graphNodeId === row.graphNodeId)) queries.push(row);
    return row.graphNodeId;
  };
  const returns = (node: ts.Node, seen = new Set<ts.Node>()): string[] => {
    if (seen.has(node)) return [];
    seen.add(node);
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const target = names.resolveValue(node) ?? (ts.isIdentifier(node) ? names.resolveName(node.getSourceFile().fileName, node.text) : names.resolveProperty(node));
      if (target && (ts.isArrowFunction(target) || ts.isFunctionExpression(target) || ts.isFunctionDeclaration(target))) return returns(target, seen);
    }
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.body) {
      if (!ts.isBlock(node.body)) return [query(node.body)];
      const found: string[] = [];
      const visit = (part: ts.Node): void => {
        if (ts.isFunctionLike(part)) return;
        if (ts.isReturnStatement(part) && part.expression) found.push(query(part.expression));
        else part.forEachChild(visit);
      };
      node.body.forEachChild(visit);
      return found;
    }
    return ts.isExpression(node) ? [query(node)] : [];
  };
  const roots = scopes.map(scope => {
    let target: ts.Node | undefined;
    const visit = (node: ts.Node): void => {
      if (node.getStart() === scope.span[0] && node.getEnd() === scope.span[1]) target = node;
      if (node.getStart() <= scope.span[0] && node.getEnd() >= scope.span[1]) node.forEachChild(visit);
    };
    compiled.program.fileAt(scope.file)?.forEachChild(visit);
    return { scope: scope.graphNodeId, queries: target ? returns(target) : [] };
  });
  const application: Array<ReturnType<typeof queries.slice>[number]> = [];
  const outer = (expression: ts.Expression, seen = new Set<ts.Node>()): void => {
    if (seen.has(expression)) return;
    seen.add(expression);
    if (ts.isIdentifier(expression)) { const value = names.resolveValue(expression); if (value) outer(value, seen); }
    else if (ts.isParenthesizedExpression(expression)) outer(expression.expression, seen);
    else if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "pipe") {
      outer(expression.expression.expression, seen);
      for (const step of expression.arguments) if (ts.isCallExpression(step) && names.callee(step) === "Effect.provide" && step.arguments[0]) {
        const id = query(step.arguments[0]), row = queries.find(item => item.graphNodeId === id)!;
        application.push(row); roots.push({ scope: id, queries: returns(step.arguments[0]) });
      }
    }
  };
  for (const entry of entries) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && names.callee(node) === "NodeRuntime.runMain" && node.arguments[0]) outer(node.arguments[0]);
      node.forEachChild(visit);
    };
    compiled.program.fileAt(resolve(compiled.program.repo, entry))?.forEachChild(visit);
  }
  return { queries, roots, application };
};

/** The source-written declaration containing a Layer expression; no name guessing. */
export const layerDefinition = (compiled: CompilerProgram, file: string, span: {start: number; end: number}) => {
  let target: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (node.getStart() <= span.start && node.getEnd() >= span.end) { target = node; node.forEachChild(visit); }
  };
  compiled.program.fileAt(resolve(compiled.program.repo, file))?.forEachChild(visit);
  if (target && ts.isIdentifier(target)) {
    const declared = compiled.project.checker.getSymbolAtLocation(target)?.declarations;
    if (declared?.length === 1) {
      const node = declared[0]!.resolve(compiled.project);
      if (node && ts.isParameterDeclaration(node)) return { name: node.name.getText(), file,
        line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1, parameter: true };
    }
  }
  if (target && (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target))) return undefined;
  for (let node = target; node; node = node.parent) {
    if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name) {
      const owner = ts.isClassDeclaration(node.parent) ? node.parent.name?.text : undefined;
      return { name: `${owner ? `${owner}.` : ""}${node.name.getText()}`, file,
        line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 };
    }
  }
  return undefined;
};
