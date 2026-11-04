import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Decode literal policy data without executing a candidate module. */
export function policy(parse, source) {
  const value = (node) => {
    if (node.type === "Literal") return node.value;
    if (node.type === "ArrayExpression") return node.elements.map(value);
    if (node.type === "ObjectExpression")
      return Object.fromEntries(
        node.properties.map((entry) => {
          if (entry.type !== "Property" || entry.computed || entry.method || entry.kind !== "init")
            throw new Error("Architecture policy must contain literal data only");
          return [entry.key.name ?? entry.key.value, value(entry.value)];
        }),
      );
    throw new Error("Architecture policy must contain literal data only");
  };
  return Object.fromEntries(
    parse(source, { ecmaVersion: "latest", sourceType: "module" }).body.flatMap((statement) => {
      if (
        statement.type !== "ExportNamedDeclaration" ||
        statement.declaration?.type !== "VariableDeclaration"
      )
        throw new Error("Architecture policy must contain exported literal constants only");
      return statement.declaration.declarations.map((entry) => {
        if (entry.id.type !== "Identifier")
          throw new Error("Architecture policy must use named constants");
        return [entry.id.name, value(entry.init)];
      });
    }),
  );
}

export function newAllowances(before, after, path = "debt") {
  if (typeof before === "number" && typeof after === "number")
    return after > before ? [`${path}: raised from ${before} to ${after}`] : [];
  if (Array.isArray(before) && Array.isArray(after))
    return after.flatMap((value) => (before.includes(value) ? [] : [`${path}: added ${value}`]));
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  )
    return Object.entries(after).flatMap(([key, value]) =>
      Object.hasOwn(before, key)
        ? newAllowances(before[key], value, `${path}.${key}`)
        : [`${path}: added ${key}`],
    );
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [`${path}: changed allowance`];
}

export function comparePolicy(before, after, shrinking) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
    shrinking.includes(key)
      ? newAllowances(before[key], after[key], key)
      : JSON.stringify(before[key]) === JSON.stringify(after[key])
        ? []
        : [`${key}: approved rule changed`],
  );
}

const sourceFile = /\.tsx?$/;
const isComment = (line) => /^(?:\/\/|\/\*|\*)/.test(line);

/** Every source file under each `packages/<name>/src`, as repository-relative paths. */
function sources(root) {
  const walk = (directory) =>
    readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(`${directory}/${entry.name}`)
        : sourceFile.test(entry.name)
          ? [`${directory}/${entry.name}`]
          : [],
    );
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "src")))
    .flatMap((entry) => walk(`packages/${entry.name}/src`));
}

/**
 * Measures how much code a reader faces: non-blank, non-comment lines per package; names each
 * package entry point exports; and, per CLI command, the source files reachable from its
 * definition. Reachability follows each imported name to the file that declares it, so a barrel
 * contributes only the names a file uses.
 */
export function measure(root) {
  const files = sources(root);
  const lines = {};
  for (const file of files) {
    const pkg = file.split("/").slice(0, 3).join("/");
    lines[pkg] =
      (lines[pkg] ?? 0) +
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !isComment(line)).length;
  }

  const ts = createRequire(join(root, "packages/tui/package.json"))("typescript");
  const entries = new Map();
  for (const entry of readdirSync(join(root, "packages"))) {
    const manifest = join(root, "packages", entry, "package.json");
    if (!existsSync(manifest)) continue;
    const { name, exports = {} } = JSON.parse(readFileSync(manifest, "utf8"));
    for (const [subpath, target] of Object.entries(exports)) {
      const built = typeof target === "string" ? target : (target.import ?? target.default);
      entries.set(
        `${name}${subpath.slice(1)}`,
        join(root, "packages", entry, built.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")),
      );
    }
  }
  const options = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
    allowJs: false,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  // Workspace packages resolve to their source, not to possibly stale build output.
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions, file) =>
    literals.map((literal) => {
      const workspace = entries.get(literal.text);
      if (workspace)
        return {
          resolvedModule: {
            resolvedFileName: workspace,
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          },
        };
      return ts.resolveModuleName(
        literal.text,
        containingFile,
        compilerOptions,
        host,
        undefined,
        redirected,
        ts.getModeForUsageLocation(file, literal, compilerOptions),
      );
    });
  const program = ts.createProgram(
    files.map((file) => join(root, file)),
    options,
    host,
  );
  const checker = program.getTypeChecker();
  const local = (fileName) => {
    const path = relative(root, fileName);
    return /^packages\/[^/]+\/src\//.test(path) ? path : undefined;
  };
  const moduleFile = (specifier) =>
    checker.getSymbolAtLocation(specifier)?.declarations?.[0]?.getSourceFile().fileName;
  const declaredIn = (name) => {
    let symbol = checker.getSymbolAtLocation(name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return (symbol?.declarations ?? []).map((declaration) => declaration.getSourceFile().fileName);
  };
  const dependencies = (sourceFile) => {
    const found = [];
    const visit = (node) => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (!clause) found.push(moduleFile(node.moduleSpecifier));
        else {
          if (clause.name) found.push(...declaredIn(clause.name));
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings))
            found.push(moduleFile(node.moduleSpecifier));
          else if (bindings)
            for (const element of bindings.elements) found.push(...declaredIn(element.name));
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        if (!node.exportClause || ts.isNamespaceExport(node.exportClause))
          found.push(moduleFile(node.moduleSpecifier));
        else
          for (const element of node.exportClause.elements) found.push(...declaredIn(element.name));
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      )
        found.push(moduleFile(node.arguments[0]));
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found.flatMap((fileName) => (fileName ? [local(fileName)].filter(Boolean) : []));
  };
  const reachable = (start) => {
    const seen = new Set([start]);
    for (const file of seen)
      for (const next of dependencies(program.getSourceFile(join(root, file)))) seen.add(next);
    return seen.size;
  };

  const publicExports = {};
  for (const [name, file] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    const module = checker.getSymbolAtLocation(program.getSourceFile(file));
    publicExports[name] = module ? checker.getExportsOfModule(module).length : 0;
  }

  const featureFiles = {};
  for (const file of files.filter((path) => path.startsWith("packages/cli/src/")).sort()) {
    const sourceFile = program.getSourceFile(join(root, file));
    for (const statement of sourceFile.statements)
      if (
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      )
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.name.text.endsWith("CliCommand"))
            featureFiles[declaration.name.text] = reachable(file);
  }
  return {
    lines: Object.fromEntries(Object.entries(lines).sort(([a], [b]) => a.localeCompare(b))),
    publicExports,
    featureFiles: Object.fromEntries(
      Object.entries(featureFiles).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

/** Measurements above their approved limit, or without one. */
export function exceeded(limits, measured) {
  return Object.entries(measured).flatMap(([kind, values]) =>
    Object.entries(values).flatMap(([name, value]) =>
      limits[kind]?.[name] === undefined
        ? [`${kind}.${name}: ${value} has no approved limit`]
        : value > limits[kind][name]
          ? [`${kind}.${name}: ${value} exceeds approved ${limits[kind][name]}`]
          : [],
    ),
  );
}

export function check(root, base) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const revision = git("rev-parse", "--verify", `${base}^{commit}`).trim();
  const tracked = new Set(git("ls-tree", "-r", "--name-only", revision).trim().split("\n"));
  const before = (file) => git("show", `${revision}:${file}`);
  const after = (file) => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  };
  const { parse } = createRequire(join(root, "packages/skit/package.json"))("acorn");
  const failures = [];
  for (const [file, shrinking] of [
    ["architecture/boundaries.mjs", ["debt", "serviceDebt"]],
    ["architecture/layout.mjs", ["layoutDebt", "importDebt"]],
    ["architecture/size.mjs", ["lines", "publicExports", "featureFiles"]],
  ]) {
    if (!tracked.has(file)) continue;
    const current = after(file);
    if (current === undefined) failures.push(`${file}: policy removed`);
    else
      failures.push(
        ...comparePolicy(policy(parse, before(file)), policy(parse, current), shrinking).map(
          (failure) => `${file}: ${failure}`,
        ),
      );
  }
  for (const file of tracked) {
    if (
      (file.startsWith("architecture/") && !file.endsWith(".mjs")) ||
      file.startsWith("lint/") ||
      [".oxlintrc.json", "vitest.lint.config.ts", "scripts/check-architecture.mjs"].includes(file)
    ) {
      if (before(file) !== after(file))
        failures.push(`${file}: contract or enforcement changed; review separately`);
    }
  }
  const changed = new Set([
    ...git("diff", "--name-only", revision).trim().split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").trim().split("\n"),
  ]);
  for (const file of changed) {
    if (
      /(?:^|\/)(?:\.oxlintrc\.[^/]+|eslint\.config\.[^/]+)$/.test(file) &&
      (!tracked.has(file) || before(file) !== after(file))
    ) {
      failures.push(`${file}: lint configuration changed; review separately`);
    }
  }
  const suppressions = (source) => source?.match(/(?:oxlint|eslint)-disable[^\r\n]*/g) ?? [];
  for (const file of changed)
    if (/\.[cm]?[jt]sx?$/.test(file))
      failures.push(
        ...newAllowances(
          suppressions(tracked.has(file) ? before(file) : ""),
          suppressions(after(file)),
          `${file}: suppressions`,
        ),
      );
  if (tracked.has("architecture/size.mjs"))
    failures.push(
      ...exceeded(policy(parse, before("architecture/size.mjs")), measure(root)).map(
        (failure) => `architecture/size.mjs: ${failure}`,
      ),
    );
  return { baseline: revision, status: failures.length ? "FAIL" : "PASS", failures };
}

if (
  process.argv[1] === "-" ||
  (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  try {
    if (args.includes("--measure")) {
      const measured = measure(resolve(option("--root") ?? process.cwd()));
      process.stdout.write(`${JSON.stringify(measured, null, 2)}\n`);
      process.exit(0);
    }
    const base = option("--base");
    if (!base)
      throw new Error(
        "Usage: node check-architecture.mjs --base <approved-commit> [--root <checkout>]",
      );
    const result = check(resolve(option("--root") ?? process.cwd()), base);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === "PASS" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
