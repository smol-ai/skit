import { join, relative } from "node:path";
import ts from "typescript";

/** Follow the executable tree before its providers erase leaf error types. */
export function commandErrors(
  program: ts.Program,
  root: string,
): ReadonlyMap<string, readonly string[]> {
  const checker = program.getTypeChecker();
  const result = new Map<string, readonly string[]>();
  const declaration = (node: ts.Node) => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration;
  };
  const commandType = (node: ts.Node): readonly ts.Type[] | undefined => {
    const type = checker.getTypeAtLocation(node);
    if (type.symbol?.name !== "Command") return;
    return checker.getTypeArguments(type as ts.TypeReference);
  };
  const strings = (type: ts.Type): string[] =>
    type.isUnion() ? type.types.flatMap(strings) : type.isStringLiteral() ? [type.value] : [];
  const errorKeys = (type: ts.Type): string[] => {
    if (type.isUnion()) return type.types.flatMap(errorKeys);
    if (type.flags & ts.TypeFlags.Never) return [];
    const node = type.symbol?.declarations?.find(
      (node) => ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node),
    );
    if (!node?.name) throw new Error(`Cannot resolve command error: ${checker.typeToString(type)}`);
    return [`${relative(root, node.getSourceFile().fileName)}/${node.name.text}`];
  };
  const children = (node: ts.Expression): readonly ts.Expression[] => {
    if (ts.isIdentifier(node)) {
      const value = declaration(node);
      return value && ts.isVariableDeclaration(value) && value.initializer
        ? children(value.initializer)
        : [];
    }
    if (!ts.isCallExpression(node)) return [];
    if (node.expression.getText() === "Command.provide") return children(node.arguments[0]!);
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "pipe") {
      for (const arg of node.arguments) {
        if (ts.isCallExpression(arg) && arg.expression.getText() === "Command.withSubcommands") {
          const list = arg.arguments[0];
          if (!list || !ts.isArrayLiteralExpression(list))
            throw new Error("Expected a literal command tree");
          return [...list.elements];
        }
      }
      return children(node.expression.expression);
    }
    return [];
  };
  const walk = (node: ts.Expression, path: readonly string[]) => {
    let args = commandType(node);
    // Factories can retain a generic name; their signature still exposes the exact error type.
    if (!args && ts.isIdentifier(node)) {
      const value = declaration(node);
      if (
        value &&
        ts.isVariableDeclaration(value) &&
        value.initializer &&
        ts.isCallExpression(value.initializer)
      ) {
        const signature = checker.getResolvedSignature(value.initializer);
        const type = signature && checker.getReturnTypeOfSignature(signature);
        if (type?.symbol?.name === "Command")
          args = checker.getTypeArguments(type as ts.TypeReference);
      }
    }
    if (!args?.[0] || !args[3]) throw new Error(`Cannot inspect command: ${node.getText()}`);
    const names = strings(args[0]);
    if (!names.length) throw new Error(`Cannot resolve command name: ${node.getText()}`);
    const subcommands = children(node);
    for (const name of names) {
      const next = name === "skit" ? path : [...path, name];
      if (subcommands.length) for (const child of subcommands) walk(child, next);
      else {
        const key = next.join(" ");
        const keys = [...new Set(errorKeys(args[3]))].sort();
        if (result.has(key) && JSON.stringify(result.get(key)) !== JSON.stringify(keys))
          throw new Error(`Ambiguous command error entry: ${key}`);
        result.set(key, keys);
      }
    }
  };
  const tree = program.getSourceFile(join(root, "packages/cli/src/commands/tree.ts"));
  const entry = tree?.statements
    .flatMap((statement) =>
      ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
    )
    .find((node) => node.name.getText() === "skitCommand");
  if (!entry?.initializer) throw new Error("Executable command tree missing");
  walk(entry.initializer, []);
  return result;
}
