import { resolve, relative } from "node:path";
import * as ts from "./syntax.ts";
import type { CompilerProgram } from "./compiler-program.ts";
import { nameResolution } from "./composition-walker.ts";

/** Local correction: executable command identities and pre-provision contract positions. */
export const commandQueries = (compiled: CompilerProgram, entryFile: string, exportName: string) => {
  const names = nameResolution(compiled), checker = compiled.project.checker;
  const file = compiled.program.fileAt(resolve(compiled.program.repo, entryFile));
  const entry = file?.statements.flatMap((statement) => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
    .find((node) => node.name.getText() === exportName);
  if (!entry?.initializer) throw new Error(`Command tree missing: ${entryFile}#${exportName}`);
  const value = (node: ts.Expression): ts.Expression => {
    if (ts.isIdentifier(node)) {
      const found = names.resolveValue(node);
      if (found && found !== node) return value(found);
    }
    return node;
  };
  const children = (expression: ts.Expression): ReadonlyArray<ts.Expression> => {
    const node = value(expression);
    if (!ts.isCallExpression(node)) return [];
    if (names.callee(node) === "Command.provide" && node.arguments.length > 1) return children(node.arguments[0]!);
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "pipe") {
      for (const arg of node.arguments) if (ts.isCallExpression(arg) && names.callee(arg) === "Command.withSubcommands") {
        const list = arg.arguments[0];
        if (!list || !ts.isArrayLiteralExpression(list)) throw new Error("Expected literal command children");
        return list.elements.filter(ts.isExpression);
      }
      return children(node.expression.expression);
    }
    return [];
  };
  const raw = (expression: ts.Expression): ts.Expression => {
    const node = value(expression);
    if (ts.isCallExpression(node)) {
      if (names.callee(node) === "Command.provide" && node.arguments.length > 1) return raw(node.arguments[0]!);
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "pipe") return raw(node.expression.expression);
    }
    return node;
  };
  // Command providers are scoped by the real exported tree, not by matching names globally.
  const scope = (node: ts.Expression) => {
    const file = node.getSourceFile(), start = node.getStart(file), at = file.getLineAndCharacterOfPosition(start);
    return { name: node.getText(file), file: file.fileName, line: at.line + 1, column: at.character + 1,
      graphNodeId: `scope:${file.fileName}:${start}`, span: [start, node.getEnd()] as const };
  };
  const provision = (expression: ts.Expression): ReturnType<typeof scope>[] => {
    const node = value(expression);
    if (!ts.isCallExpression(node)) return [];
    if (names.callee(node) === "Command.provide" && node.arguments.length > 1)
      return [...provision(node.arguments[0]!), scope(node.arguments[1]!)];
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "pipe")
      return [...provision(node.expression.expression), ...node.arguments.flatMap(arg =>
        ts.isCallExpression(arg) && names.callee(arg) === "Command.provide" && arg.arguments[0] ? [scope(arg.arguments[0])] : [])];
    return [];
  };
  const rows: Array<{ command: string; graphNodeId: string; file: string; line: number; column: number; span: readonly [number, number]; scopes: ReturnType<typeof scope>[] }> = [];
  const visit = (node: ts.Expression, parent: ReadonlyArray<string>, inherited: ReturnType<typeof scope>[] = []) => {
    const scopes = [...provision(node), ...inherited];
    const type = checker.getTypeAtLocation(node);
    if (!type.isTypeReference() || type.getSymbol()?.name !== "Command") throw new Error(`Command type missing: ${node.getText()}`);
    const [name] = checker.getTypeArguments(type);
    const choices = name?.isUnionType() ? name.getTypes() : name ? [name] : [];
    const labels = choices.flatMap((part) => { const label = checker.typeToString(part); return /^".*"$/.test(label) ? [JSON.parse(label) as string] : []; });
    if (!labels.length) throw new Error(`Command name missing: ${node.getText()}`);
    const subcommands = children(node);
    for (const label of labels) {
      const path = label === "skit" ? parent : [...parent, label];
      if (subcommands.length) for (const child of subcommands) visit(child, path, scopes);
      else {
        const expression = raw(node), source = expression.getSourceFile(), start = expression.getStart(source);
        const at = source.getLineAndCharacterOfPosition(start), command = path.join(" ");
        rows.push({ command, graphNodeId: `command:${command}:${start}`, file: source.fileName,
          line: at.line + 1, column: at.character + 1, span: [start, expression.getEnd()], scopes });
      }
    }
  };
  visit(entry.initializer, []);
  return rows;
};
