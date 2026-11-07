import ts from "typescript-parser";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const canonical = (file) => (existsSync(file) ? realpathSync(file) : resolve(file));
const key = (file, name) => `${canonical(file)}:${name}`;

/** Only foreign references count: merely emitting an exported declaration is not usage. */
export function declarationUses(projects, packageEntries = new Map()) {
  const declarations = new Map();
  for (const { output, source } of projects) {
    const scan = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (file.endsWith(".d.ts")) {
          const original = resolve(source, relative(output, file).replace(/\.d\.ts$/, ".ts"));
          if (existsSync(original)) declarations.set(canonical(file), canonical(original));
        }
      }
    };
    scan(output);
  }
  const target = (file, specifier) => {
    if (packageEntries.has(specifier)) return canonical(packageEntries.get(specifier));
    if (!specifier.startsWith(".")) return;
    const path = resolve(dirname(file), specifier);
    return declarations.get(canonical(path.replace(/\.js$/, ".d.ts")));
  };
  const uses = new Map();
  const add = (file, specifier, name) => {
    const original = target(file, specifier);
    if (!original || original === declarations.get(canonical(file)) || !name) return;
    const id = key(original, name);
    if (!uses.has(id)) uses.set(id, `${file} -> ${specifier}.${name}`);
  };
  const first = (node) =>
    ts.isQualifiedName(node)
      ? first(node.left)
      : ts.isPropertyAccessExpression(node)
        ? first(node.expression)
        : node.text;
  const member = (node) =>
    ts.isQualifiedName(node)
      ? ts.isQualifiedName(node.left)
        ? member(node.left)
        : node.right.text
      : ts.isPropertyAccessExpression(node)
        ? ts.isPropertyAccessExpression(node.expression)
          ? member(node.expression)
          : node.name.text
        : undefined;
  for (const file of declarations.keys()) {
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const imports = new Map();
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) || !node.importClause?.namedBindings) continue;
      const bindings = node.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const item of bindings.elements)
          imports.set(item.name.text, {
            specifier: node.moduleSpecifier.text,
            name: (item.propertyName ?? item.name).text,
          });
      } else if (ts.isNamespaceImport(bindings))
        imports.set(bindings.name.text, { specifier: node.moduleSpecifier.text });
    }
    const visit = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal) &&
        node.qualifier
      )
        add(file, node.argument.literal.text, first(node.qualifier));
      const reference = ts.isTypeReferenceNode(node)
        ? node.typeName
        : ts.isTypeQueryNode(node)
          ? node.exprName
          : ts.isExpressionWithTypeArguments(node)
            ? node.expression
            : undefined;
      if (reference) {
        const imported = imports.get(first(reference));
        if (imported) add(file, imported.specifier, imported.name ?? member(reference));
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  // Re-exporting a name is not itself a use. Follow an alias only after a real reference reaches it.
  for (const [id, evidence] of uses) {
    const split = id.lastIndexOf(":"),
      file = id.slice(0, split),
      name = id.slice(split + 1);
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of ast.statements) {
      if (
        !ts.isExportDeclaration(node) ||
        !node.moduleSpecifier ||
        !node.exportClause ||
        !ts.isNamedExports(node.exportClause)
      )
        continue;
      for (const item of node.exportClause.elements) {
        if (item.name.text !== name) continue;
        const specifier = node.moduleSpecifier.text;
        const original =
          packageEntries.get(specifier) ??
          (specifier.startsWith(".")
            ? resolve(dirname(file), specifier).replace(/\.js$/, ".ts")
            : undefined);
        if (original && existsSync(original)) {
          const next = key(original, (item.propertyName ?? item.name).text);
          if (!uses.has(next)) uses.set(next, `${evidence}; via ${id}`);
        }
      }
    }
  }
  return uses;
}

/** Leave every non-type finding untouched, including file and cycle findings. */
export function remainingIssues(report, uses, root) {
  return {
    ...report,
    issues: report.issues.map((issue) => ({
      ...issue,
      types: issue.types.filter((type) => !uses.has(key(resolve(root, issue.file), type.name))),
    })),
  };
}

export function hasIssues(report) {
  return Object.entries(report).some(([name, value]) =>
    name === "issues"
      ? value.some((issue) =>
          Object.entries(issue).some(
            ([field, items]) => field !== "file" && Array.isArray(items) && items.length,
          ),
        )
      : Array.isArray(value) && value.length,
  );
}
