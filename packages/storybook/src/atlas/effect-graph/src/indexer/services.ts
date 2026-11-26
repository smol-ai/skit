import { relative, resolve } from "node:path";
import { SignatureKind, SymbolFlags, TypeFormatFlags, type Type } from "tsrs/sync";
import * as ts from "./syntax.ts";
import type { CompilerProgram } from "./compiler-program.ts";

/** Local correction: declarations, including tags never reached by a runtime root. */
export const serviceDeclarations = (compiled: CompilerProgram, owners: ReadonlyArray<{ readonly file: string; readonly name: string }> = [], objects: ReadonlyArray<{ prefix: string; name: string }> = []) => {
  const checker = compiled.project.checker;
  const requestedOwners = [...owners];
  const at = (node: ts.Node) => {
    const source = node.getSourceFile(), position = source.getLineAndCharacterOfPosition(node.getStart(source));
    return { file: relative(compiled.program.repo, source.fileName), line: position.line + 1 };
  };
  const operations = (type: Type, anchor: ts.Node, prefix = "", depth = 0): Array<{ name: string; signature: string; file: string; line: number }> => {
    if (depth > 3 || !type.isObjectType() && !type.isIntersectionType()) return [];
    return checker.getPropertiesOfType(type).flatMap((property) => {
      const name = `${prefix}${property.name}`, member = checker.getTypeOfSymbolAtLocation(property, anchor);
      const declarations = property.declarations.flatMap((handle) => { try { return [handle.resolve(compiled.project)]; } catch { return []; } });
      const source = declarations[0] ?? anchor;
      if (!source.getSourceFile().fileName.startsWith(`${compiled.program.repo}/packages/`)) return [];
      if (checker.getSignaturesOfType(member, SignatureKind.Call).length || member.getSymbol()?.name === "Effect")
        return [{ name, signature: checker.typeToString(member, anchor, TypeFormatFlags.NoTruncation | TypeFormatFlags.InTypeAlias), ...at(source) }];
      return operations(member, anchor, `${name}.`, depth + 1);
    });
  };
  const rows: Array<{ id: string; name: string; identifier: string; kind: string; file: string; line: number; description?: string; operations: ReturnType<typeof operations> }> = [];
  const add = (node: ts.Node, name: string, call: ts.CallExpression, kind: string) => {
    let typed: ts.CallExpression | undefined = call;
    while (typed && !typed.typeArguments?.length) typed = ts.isCallExpression(typed.expression) ? typed.expression : undefined;
    const shape = typed?.typeArguments?.[1] ?? (ts.isVariableDeclaration(node) ? typed?.typeArguments?.[0] : undefined);
    const tag = call.arguments.find(ts.isStringLiteralLike);
    const source = at(node);
    if (kind === "Service" && typed?.typeArguments?.[0]?.getText() === "never") kind = "Annotation";
    const documented = ts.isVariableDeclaration(node) ? node.parent.parent : node;
    const prefix = documented.getSourceFile().text.slice(documented.getStart(undefined, true), documented.getStart());
    const doc = /\/\*\*([\s\S]*?)\*\//.exec(prefix)?.[1];
    const description = doc?.split("\n").map(line => line.replace(/^\s*\* ?/, "").trim()).filter(line => !line.startsWith("@")).join(" ").trim();
    rows.push({ ...(description ? { description } : {}), id: `${source.file}#${name}`, name, identifier: tag?.text ?? name, kind, ...source,
      operations: shape && kind !== "Annotation" ? operations(checker.getTypeFromTypeNode(shape), shape) : [] });
  };
  for (const path of compiled.program.paths) {
    const file = compiled.program.fileAt(path);
    if (!file) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) for (const clause of node.heritageClauses ?? []) for (const base of clause.types) {
        if (ts.isExpressionWithTypeArguments(base) && ts.isCallExpression(base.expression) && /(?:Context|HttpApiMiddleware)\.(?:Service|Reference)/.test(base.expression.getText(file)))
          add(node, node.name.text, base.expression, /HttpApiMiddleware/.test(base.expression.getText(file)) ? "Middleware" : "Service");
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
        && /Context\.(?:Service|Reference)$/.test(node.initializer.expression.getText(file)))
        add(node, node.name.text, node.initializer, node.initializer.expression.getText(file).endsWith("Reference") ? "Reference" : "Service");
      const ownerName = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : undefined;
      if (ownerName && objects.some(object => object.name === ownerName && at(node).file.startsWith(object.prefix)))
        requestedOwners.push({ file: at(node).file, name: ownerName });
      node.forEachChild(visit);
    };
    visit(file);
  }
  for (const owner of requestedOwners) {
    const file = compiled.program.fileAt(resolve(compiled.program.repo, owner.file));
    const module = file && checker.getSymbolAtLocation(file);
    let symbol = module && checker.getExportsOfModule(module).find((symbol) => symbol.name === owner.name);
    if (!symbol || !file) throw new Error(`Declared owner missing: ${owner.file}#${owner.name}`);
    if (symbol.flags & SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const node = symbol.valueDeclaration?.resolve(compiled.project) ?? symbol.declarations[0]?.resolve(compiled.project);
    if (!node) throw new Error(`Declared owner has no source: ${owner.file}#${owner.name}`);
    const source = at(node), id = `${source.file}#${symbol.name}`;
    if (rows.some((row) => row.id === id)) continue;
    const type = ts.isClassDeclaration(node) ? checker.getDeclaredTypeOfSymbol(symbol) : checker.getTypeAtLocation(node);
    const signatures = checker.getSignaturesOfType(type, SignatureKind.Call);
    rows.push({ id, name: symbol.name, identifier: symbol.name, kind: "Owner", ...source,
      operations: signatures.length ? [{ name: symbol.name, signature: checker.typeToString(type, node, TypeFormatFlags.NoTruncation | TypeFormatFlags.InTypeAlias), ...source }]
        : operations(type, node) });
  }
  return rows.sort((a,b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
};

/** Named provider definitions include factories; their contracts do not claim execution. */
export const providerQueries = (compiled: CompilerProgram) => {
  const checker = compiled.project.checker;
  const rows: Array<{ name: string; graphNodeId: string; file: string; line: number; column: number; span: readonly [number, number] }> = [];
  const isLayer = (type: Type) => type.isTypeReference() && type.getSymbol()?.name === "Layer"
    && type.getSymbol()?.declarations.some((decl) => /effect\/dist\/Layer\.d\.ts$/i.test(decl.path));
  for (const path of compiled.program.paths) {
    const file = compiled.program.fileAt(path);
    if (!file) continue;
    const visit = (node: ts.Node): void => {
      if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer) {
        const expression = node.initializer, type = checker.getTypeAtLocation(expression);
        if (isLayer(type) || checker.getSignaturesOfType(type, SignatureKind.Call).some((signature) => isLayer(checker.getReturnTypeOfSignature(signature)))) {
          const start = expression.getStart(file), at = file.getLineAndCharacterOfPosition(start);
          rows.push({ name: node.name.getText(file), graphNodeId: `provider:${path}:${start}`, file: path,
            line: at.line + 1, column: at.character + 1, span: [start, expression.getEnd()] });
        }
      }
      node.forEachChild(visit);
    };
    visit(file);
  }
  return rows;
};
