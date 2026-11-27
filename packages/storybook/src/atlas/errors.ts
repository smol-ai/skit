import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";
import type { ErrorDefinition } from "./data.ts";

/** Build from source, including errors with no story or presentation, rather than a hand-kept list. */
export async function atlasProgram(root: string): Promise<ts.Program> {
  const files: string[] = [];
  const paths: Record<string, string[]> = {};
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
    }
  };
  for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, "packages", entry.name);
    const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      const target = typeof value === "string" ? value : (value as { import?: string }).import;
      if (target?.startsWith("./dist/")) {
        paths[`${pkg.name}${key === "." ? "" : key.slice(1)}`] = [
          join(directory, target.replace("./dist/", "src/").replace(/\.js$/, ".ts")),
        ];
      }
    }
    try {
      await walk(join(directory, "src"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths,
    skipLibCheck: true,
    strict: true,
  });
  return program;
}

/** Public for focused source fixtures; TypeScript resolves aliases and union membership. */
export function inspectErrors(
  program: ts.Program,
  root: string,
  ownerFiles: readonly string[] = [],
): readonly ErrorDefinition[] {
  const checker = program.getTypeChecker();
  const allSources = program
    .getSourceFiles()
    .filter(
      (file) => !file.isDeclarationFile && file.fileName.startsWith(join(root, "packages") + "/"),
    );
  const errors = new Map<ts.Declaration, ts.ClassDeclaration>();
  const symbolAt = (node: ts.Node) => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  };
  const visit = (node: ts.Node, fn: (node: ts.Node) => void) => {
    fn(node);
    ts.forEachChild(node, (child) => visit(child, fn));
  };
  const reachable = new Set<ts.SourceFile>();
  const include = (file: ts.SourceFile) => {
    if (reachable.has(file) || !allSources.includes(file)) return;
    reachable.add(file);
    for (const statement of file.statements) {
      if (
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier
      ) {
        for (const declaration of symbolAt(statement.moduleSpecifier)?.declarations ?? []) {
          include(declaration.getSourceFile());
        }
      }
    }
  };
  for (const file of allSources) {
    if (file.fileName.includes("/packages/cli/src/") && !file.fileName.includes("/storybook/"))
      include(file);
  }
  for (const path of ownerFiles) {
    const file = program.getSourceFile(join(root, path));
    if (!file) throw new Error(`Error owner source missing: ${path}`);
    include(file);
  }
  const sources = [...reachable];
  for (const file of sources)
    visit(file, (node) => {
      if (
        ts.isClassDeclaration(node) &&
        node.name &&
        node.heritageClauses?.some((clause) => /\bTaggedError\b/.test(clause.getText(file)))
      ) {
        errors.set(node, node);
      }
    });
  // Only expand declared unions. Following arbitrary function bodies would mistake callers
  // and incidental implementation dependencies for errors in an interface.
  const referencedErrors = (node: ts.Node): Set<ts.ClassDeclaration> => {
    const found = new Set<ts.ClassDeclaration>();
    const seen = new Set<ts.Node>();
    const scan = (node: ts.Node) => {
      if (seen.has(node)) return;
      seen.add(node);
      visit(node, (child) => {
        if (!ts.isIdentifier(child)) return;
        for (const declaration of symbolAt(child)?.declarations ?? []) {
          const error = errors.get(declaration);
          if (error) found.add(error);
          else if (ts.isTypeAliasDeclaration(declaration)) scan(declaration.type);
          else if (ts.isInterfaceDeclaration(declaration)) scan(declaration);
          else if (
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            /\b(?:Union|TaggedUnion)\b/.test(declaration.initializer.getText())
          )
            scan(declaration.initializer);
        }
      });
    };
    scan(node);
    return found;
  };
  const serviceErrors = (node: ts.Node): Set<ts.ClassDeclaration> => {
    const found = new Set<ts.ClassDeclaration>();
    const seen = new Set<ts.Node>();
    const scan = (node: ts.Node) => {
      if (seen.has(node)) return;
      seen.add(node);
      if (
        ts.isTypeReferenceNode(node) &&
        /^(?:Effect\.)?Effect$/.test(node.typeName.getText()) &&
        node.typeArguments?.[1]
      ) {
        for (const error of referencedErrors(node.typeArguments[1])) found.add(error);
        return;
      }
      if (ts.isIdentifier(node)) {
        for (const declaration of symbolAt(node)?.declarations ?? []) {
          if (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration))
            scan(declaration);
        }
      }
      ts.forEachChild(node, scan);
    };
    scan(node);
    return found;
  };
  const services = new Map<ts.ClassDeclaration, string[]>();
  const presentations = new Map<ts.ClassDeclaration, ErrorDefinition["presentations"][number][]>();
  for (const file of sources) {
    visit(file, (node) => {
      if (
        ts.isClassDeclaration(node) &&
        node.name &&
        node.heritageClauses?.some((clause) =>
          /\b(?:Context|ServiceMap)\.Service\b/.test(clause.getText()),
        )
      ) {
        for (const error of serviceErrors(node)) {
          services.set(error, [
            ...(services.get(error) ?? []),
            `${node.name.text} (${relative(root, file.fileName)})`,
          ]);
        }
      }
    });
    if (
      !/packages\/cli\/src\/.*failures?\.ts$/.test(file.fileName) ||
      file.fileName.endsWith("/commands/data-failure.ts")
    )
      continue;
    const found = referencedErrors(file);
    for (const error of found) {
      presentations.set(error, [
        ...(presentations.get(error) ?? []),
        { file: relative(root, file.fileName), source: file.text },
      ]);
    }
  }
  const evidence = new Map<ts.ClassDeclaration, ErrorDefinition["evidence"][number][]>();
  const record = (
    error: ts.ClassDeclaration,
    kind: ErrorDefinition["evidence"][number]["kind"],
    node: ts.Node,
  ) => {
    const file = node.getSourceFile();
    const item = {
      kind,
      file: relative(root, file.fileName),
      line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      source: node.getText(file),
    };
    const entries = evidence.get(error) ?? [];
    if (
      !entries.some(
        (entry) => entry.kind === kind && entry.file === item.file && entry.line === item.line,
      )
    )
      entries.push(item);
    evidence.set(error, entries);
  };
  for (const file of sources)
    visit(file, (node) => {
      // Read the error argument of an explicit Effect type, not incidental interface references.
      if (
        ts.isTypeReferenceNode(node) &&
        /^(?:Effect\.)?Effect$/.test(node.typeName.getText(file)) &&
        node.typeArguments?.[1]
      )
        for (const error of referencedErrors(node.typeArguments[1]))
          record(error, "Checked interface", node);
      if (!ts.isNewExpression(node)) return;
      const error = symbolAt(node.expression)
        ?.declarations?.map((declaration) => errors.get(declaration))
        .find((declaration) => declaration !== undefined);
      if (!error) return;
      let parent = node.parent;
      while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
      if (ts.isThrowStatement(parent)) return record(error, "Throw", parent);
      if (ts.isYieldExpression(parent) && parent.asteriskToken)
        return record(error, "Checked failure", parent);
      if (
        ts.isCallExpression(parent) &&
        /^Effect\.(?:fail|die)$/.test(parent.expression.getText(file))
      )
        return record(
          error,
          parent.expression.getText(file) === "Effect.die" ? "Defect" : "Checked failure",
          parent,
        );
      // A returned error value in a schema transform is a stored representation, not an emission.
      let ancestor: ts.Node | undefined = parent;
      while (ancestor && !ts.isSourceFile(ancestor)) {
        if (
          ts.isCallExpression(ancestor) &&
          ancestor.expression.getText(file) === "SchemaGetter.transform"
        )
          return record(error, "Stored conversion", node);
        ancestor = ancestor.parent;
      }
      record(error, "Construction", node);
    });
  return [...errors.values()]
    .map((node) => {
      const file = node.getSourceFile();
      const uses = evidence.get(node) ?? [];
      const checked = uses.some(
        (use) => use.kind === "Checked failure" || use.kind === "Checked interface",
      );
      const defect = uses.some((use) => use.kind === "Defect" || use.kind === "Throw");
      const code = node.members.find(
        (member) => ts.isPropertyDeclaration(member) && member.name.getText(file) === "code",
      );
      const input =
        code && /["'](?:INVALID_ARGUMENT|VALIDATION_FAILED)["']/.test(code.getText(file));
      let category: ErrorDefinition["category"] = "Unclassified";
      if (checked && defect) category = "Mixed use";
      else if (defect) category = "Internal defect";
      else if (checked) category = input ? "Input validation" : "Operational failure";
      else if (uses.length > 0 && uses.every((use) => use.kind === "Stored conversion"))
        category = "Stored format conversion";
      return {
        category,
        evidence: uses.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
        tag:
          node.heritageClauses?.flatMap((clause) => {
            const tags: string[] = [];
            visit(clause, (child) => {
              if (ts.isStringLiteral(child)) tags.push(child.text);
            });
            return tags;
          })[0] ?? node.name!.text,
        name: node.name!.text,
        file: relative(root, file.fileName),
        line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        definition: node.getText(file),
        services: [...new Set(services.get(node) ?? [])].sort(),
        presentations: presentations.get(node) ?? [],
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
