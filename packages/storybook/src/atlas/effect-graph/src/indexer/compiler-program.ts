import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  API, SymbolFlags, type Checker, type CompilerOptions, type ModuleResolver, type NodeHandle, type Project,
  type Symbol as CompilerSymbol, type Type,
} from "tsrs/sync";
import { createFileSystemLayer } from "tsrs/fs";
import * as ts from "./syntax.ts";
import { graphCompilerExecutable } from "../../scripts/lib/graph-compiler.ts";
import type { Declaration } from "./composition-walker.ts";
import type { WorkerSourceFile } from "./worker-layer-graph.ts";
import { compilerFileSystem } from "./compiler-filesystem.ts";
import type { CompilerEnvironment } from "./compiler-environment.ts";
import { isCorpusFile, isGraphPackageManifest } from "../conventions.ts";

/** One repo's sources as one compiler program, each file parsed once and shared
 * by every graph pass so a syntax node is the same object wherever it is reached. */
export interface SourceProgram {
  readonly repo: string;
  /** Absolute paths of the TypeScript sources, in archive order. */
  readonly paths: ReadonlyArray<string>;
  readonly fileAt: (path: string) => ts.SourceFile | undefined;
  /** A source's text without parsing it, to rule a file out cheaply. */
  readonly textAt: (path: string) => string | undefined;
  readonly moduleTarget: (source: ts.SourceFile, specifier: string) => ts.SourceFile | undefined;
}

export interface CompilerProgram {
  readonly project: Project;
  readonly environment: () => CompilerEnvironment;
  /** A file as the compiler reads it: pinned source in the checkout, installed files beside it. */
  readonly readFile: (path: string) => string | undefined;
  readonly program: SourceProgram;
  /** Each module's names, as the compiler bound them. */
  readonly declarations: (file: ts.SourceFile) => Map<string, Declaration>;
  /** The tsconfig a file is built with: its nearest, inside the checkout. */
  readonly configFor: (file: string) => string | undefined;
  /** Those tsconfig projects, opened in this session over the same pinned sources, so a
   * fact is what each application build types a node as, under its own compiler options. */
  readonly openProjects: (configs: ReadonlyArray<string>) => (config: string) => Project | undefined;
  readonly close: () => void;
}

/** Atlas generation runs under Node; the native sync API requires its pipe handles. */
export const inNode = <A extends ReadonlyArray<unknown>, R>(_module: string, _entry: string, run: (...args: A) => R): ((...args: A) => R) => run;
let executable: string | undefined;
/** The pinned tsrs binary, the same compiler the type probe runs. */
const compilerExecutable = (): string => executable ??= graphCompilerExecutable();

const BASE: CompilerOptions = {
  noEmit: true, skipLibCheck: true, allowJs: false, strict: true,
  jsx: 1 /* Preserve */, target: 99 /* ESNext */, module: 99 /* ESNext */, moduleResolution: 100 /* Bundler */,
  allowImportingTsExtensions: true, resolveJsonModule: true,
  // Binding names needs only what files import, not every ambient @types package.
  types: [],
};

/** The module specifiers a file's imports, re-exports and dynamic imports name. */
const specifiers = (file: ts.SourceFile): ReadonlyArray<string> => {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      found.add(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) found.add(node.arguments[0].text);
    node.forEachChild(visit);
  };
  visit(file);
  return [...found];
};

/**
 * A checkout's sources as one TypeScript 7 program. `sources` are the pinned
 * text, served over the directory on disk, which supplies installed libraries
 * and tsconfig files; a directory that does not exist sees no libraries. Each
 * file resolves its imports with its nearest tsconfig's options. Requires Node:
 * the sync API needs Node's pipe handles.
 */
export const compilerProgram = (
  repoDir: string,
  sources: ReadonlyArray<WorkerSourceFile>,
  /** A library's published workspace packages are the library: a call into one from
   * another package (an example, a demo) stops there, as a call into an installed
   * library does. Private packages are the examples and tools that use it. */
  options: { readonly packageBoundaries?: boolean; readonly pinnedConfiguration?: boolean } = {},
): CompilerProgram => {
  const repo = resolve(repoDir);
  const snapshotPaths = new Set(sources.map((source) => resolve(repo, source.path)));
  const bodies = new Map(sources.filter((source) => isCorpusFile(source.path))
    .map((source) => [resolve(repo, source.path), source.text]));
  // The compiler reports declaration paths in lower case.
  const byLowerPath = new Map([...bodies.keys()].map((path) => [path.toLowerCase(), path]));
  const observed = compilerFileSystem(repo, sources, options.pinnedConfiguration === true);
  const api = new API({ cwd: existsSync(repo) ? repo : process.cwd(), tsserverPath: compilerExecutable(), fs: observed.callbacks });
  try {
    // Workspace packages resolve as an install links them: each archived manifest's
    // name under `node_modules`, unless the checkout already has that link.
    const manifests = sources.filter((source) => isGraphPackageManifest(source.path)).flatMap((source) => {
      try {
        const manifest: unknown = JSON.parse(source.text);
        const { name, private: unpublished } = typeof manifest === "object" && manifest !== null ? manifest as Record<string, unknown> : {};
        return typeof name === "string" ? [{ ...source, name, published: unpublished !== true }] : [];
      } catch { return []; }
    });
    // Local correction: workspace export declarations point at built files; inspect source.
    const sourcePaths = Object.fromEntries(manifests.flatMap(({ path, text, name }) => {
      const exports = JSON.parse(text).exports ?? {};
      return Object.entries(exports).flatMap(([key, value]) => {
        const target = typeof value === "string" ? value : (value as { import?: string })?.import;
        if (!target?.startsWith("./dist/")) return [];
        const source = resolve(repo, dirname(path), target.replace("./dist/", "src/").replace(/\.js$/, ".ts"));
        return [[`${name}${key === "." ? "" : key.slice(1)}`, [source]]];
      });
    }));
    const symlinks = Object.fromEntries(manifests.map(({ path, name }) => [join(repo, "node_modules", name), { target: dirname(resolve(repo, path)) }])
      .filter(([link]) => !observed.exists(link as string)));
    const packageDirs = [...new Set(manifests.map(({ path }) => dirname(resolve(repo, path))))].sort((a, b) => b.length - a.length);
    const packageOf = (path: string): string | undefined => packageDirs.find((dir) => path.startsWith(`${dir}/`));
    const published = new Set(manifests.filter((manifest) => manifest.published).map(({ path }) => dirname(resolve(repo, path))));
    const crosses = (from: string, to: string): boolean => {
      if (options.packageBoundaries !== true) return false;
      const target = packageOf(to);
      return target !== undefined && published.has(target) && packageOf(from) !== target;
    };
    const fileSystem = createFileSystemLayer(sources.map(({ path, text }) => [resolve(repo, path), text]), { symlinks });
    const rootFiles = [...bodies.keys()];

    const resolvers = new Map<string, ModuleResolver>();
    const configs = new Map<string, string | undefined>();
    /** The nearest tsconfig.json at or above a directory, inside the checkout. */
    const configFor = (dir: string): string | undefined => {
      if (configs.has(dir)) return configs.get(dir);
      const candidate = join(dir, "tsconfig.json");
      const present = options.pinnedConfiguration ? snapshotPaths.has(candidate) : existsSync(candidate);
      const found = present ? candidate
        : dir === repo || !dir.startsWith(`${repo}/`) ? undefined : configFor(dirname(dir));
      configs.set(dir, found);
      return found;
    };
    const resolverFor = (dir: string): ModuleResolver => {
      const config = configFor(dir) ?? "";
      let resolver = resolvers.get(config);
      if (!resolver) {
        const options = config ? { ...BASE, ...api.parseConfigFile(config).options, ...{ noEmit: true, allowJs: false, types: [], paths: sourcePaths } } : BASE;
        resolver = api.createModuleResolver(options);
        resolvers.set(config, resolver);
      }
      return resolver;
    };
    const resolutions = new Map<string, string | undefined>();
    const resolveIn = (dir: string, specifier: string): string | undefined => {
      const key = `${dir}\0${specifier}`;
      if (resolutions.has(key)) return resolutions.get(key);
      // Resolved against the parsed snapshot, whose file system holds the pinned sources.
      const resolved = resolverFor(dir).resolveModuleName(specifier, dir, undefined, { snapshot: parsed }).resolvedModule?.resolvedFileName;
      const found = typeof resolved === "string" ? resolved : undefined;
      resolutions.set(key, found);
      return found;
    };

    // Parse the sources alone (resolving nothing) to read every file's imports, resolve each
    // with its own tsconfig, then reconfigure that program with those resolutions, reusing
    // its parsed files.
    const unresolved = api.createModuleResolver(BASE, { moduleResolutions: { fallback: "unresolved", entries: [] } });
    const parsed = api.createSnapshot({ fileSystem, createPrograms: [{ rootFiles, compilerOptions: BASE, options: { moduleResolver: unresolved } }] });
    const parsedProgram = parsed.operation.createdPrograms[0];
    for (const path of rootFiles) {
      const file = parsedProgram.getSourceFile(path);
      if (file) for (const specifier of specifiers(file)) resolveIn(dirname(path), specifier);
    }
    const entries = [...resolutions].map(([key, resolvedFileName]) => {
      const [containingDirectory, moduleName] = key.split("\0") as [string, string];
      return { moduleName, containingDirectory, result: resolvedFileName ? { resolvedFileName } : {} };
    });
    const moduleResolver = api.createModuleResolver(BASE, { moduleResolutions: { fallback: "resolve", entries } });
    const snapshot = parsed.update({ reconfigurePrograms: [{ id: parsedProgram.id, rootFiles, compilerOptions: BASE, options: { moduleResolver } }] });
    const project: Project = snapshot.getProjects()[0]!;
    const checker: Checker = project.checker;

    const files = new Map<string, ts.SourceFile>();
    const fileAt = (path: string): ts.SourceFile | undefined => {
      if (!bodies.has(path)) return undefined;
      let file = files.get(path);
      if (!file) { file = project.program.getSourceFile(path); if (file) files.set(path, file); }
      return file;
    };
    const corpusPath = (path: string): string | undefined => byLowerPath.get(path.toLowerCase());
    const moduleTarget = (source: ts.SourceFile, specifier: string): ts.SourceFile | undefined => {
      const target = resolveIn(dirname(source.fileName), specifier);
      const path = target && corpusPath(target);
      return path && !crosses(source.fileName, path) ? fileAt(path) : undefined;
    };
    const program: SourceProgram = { repo, paths: rootFiles, fileAt, textAt: (path) => bodies.get(path), moduleTarget };

    /** A declaration handle's node, in the program's own copy of its file. */
    const nodeOf = (handle: NodeHandle): ts.Node | undefined => {
      const path = corpusPath(handle.path);
      return path && fileAt(path) ? handle.resolve(project) : undefined;
    };
    /** The declaration the walker follows: the value of a name that is also a type
     * (`type Id = …; const Id = Brand.nominal<Id>()`), an overloaded function's implementation. */
    const valueOf = (symbol: CompilerSymbol): NodeHandle | undefined => {
      const handles = symbol.declarations ?? [];
      const functions = handles.filter((handle) => handle.kind === ts.SyntaxKind.FunctionDeclaration);
      const implementation = functions.length > 1
        ? functions.find((handle) => { const node = nodeOf(handle); return node && ts.isFunctionDeclaration(node) && node.body; })
        : undefined;
      return implementation ?? symbol.valueDeclaration ?? handles[0];
    };

    /** How a module-scope symbol, as the compiler bound it, reads in a declaration table. */
    const declarationOf = (symbol: CompilerSymbol, alias?: ts.Node): Declaration | undefined => {
      if (symbol.flags & SymbolFlags.Alias) {
        const statement = alias && ts.findAncestor(alias, (node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node));
        const specifier = statement && (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
          && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
        const imported = !alias ? undefined
          : ts.isImportClause(alias) ? "default"
          : ts.isNamespaceImport(alias) || ts.isNamespaceExport(alias) ? "*"
          : ts.isImportSpecifier(alias) || ts.isExportSpecifier(alias) ? (alias.propertyName ?? alias.name).text
          : undefined;
        const target = checker.getAliasedSymbol(symbol);
        const handle = valueOf(target);
        const path = handle && corpusPath(handle.path);
        if (!handle || !path || !fileAt(path) || alias && crosses(alias.getSourceFile().fileName, path))
          return specifier !== undefined && imported !== undefined
          ? { kind: "package", specifier, name: imported } : undefined;
        const file = relative(repo, path);
        if (handle.kind === ts.SyntaxKind.SourceFile) return { kind: "namespace", file };
        return { kind: "import", file, name: handle.kind === ts.SyntaxKind.ExportAssignment ? "default" : target.name };
      }
      const handle = valueOf(symbol);
      const declared = handle && nodeOf(handle);
      if (!declared) return undefined;
      if (ts.isFunctionDeclaration(declared)) return declared.body ? { kind: "value", node: declared } : undefined;
      if (ts.isClassDeclaration(declared)) return { kind: "value", node: declared };
      // `export namespace Lifecycle { … }`: its members are found by name in its body.
      if (ts.isModuleDeclaration(declared) && ts.isIdentifier(declared.name) && declared.body && ts.isModuleBlock(declared.body))
        return { kind: "value", node: declared };
      if (ts.isVariableDeclaration(declared) && ts.isIdentifier(declared.name) && declared.initializer
        && ts.isVariableStatement(declared.parent.parent) && ts.isSourceFile(declared.parent.parent.parent))
        return { kind: "value", node: declared.initializer };
      if (ts.isExportAssignment(declared) && !declared.isExportEquals) {
        const named = ts.isIdentifier(declared.expression) ? checker.getSymbolAtLocation(declared.expression) : undefined;
        return (named && declarationOf(named, aliasDeclaration(named))) ?? { kind: "value", node: declared.expression };
      }
      return undefined;
    };
    const aliasDeclaration = (symbol: CompilerSymbol): ts.Node | undefined =>
      symbol.flags & SymbolFlags.Alias && symbol.declarations?.[0] ? nodeOf(symbol.declarations[0]) : undefined;

    /** What a binding element names when its object is a module namespace
     * (`const { A } = yield* Effect.promise(() => import("./a"))`). */
    const destructuredExport = (element: ts.BindingElement, type: Type | undefined): Declaration | undefined => {
      const module = type?.getSymbol()?.declarations?.[0];
      const path = module?.kind === ts.SyntaxKind.SourceFile ? corpusPath(module.path) : undefined;
      if (!type || !path || !element.name || !ts.isIdentifier(element.name)) return undefined;
      const name = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
      return checker.getPropertyOfType(type, name) ? { kind: "import", file: relative(repo, path), name } : undefined;
    };

    /** A declaration this module may follow: none that crosses into another package of a library. */
    const within = (file: ts.SourceFile, declaration: Declaration | undefined): Declaration | undefined => {
      const path = declaration?.kind === "value" ? declaration.node.getSourceFile().fileName
        : declaration?.kind === "import" || declaration?.kind === "namespace" ? resolve(repo, declaration.file) : undefined;
      return path !== undefined && crosses(file.fileName, path) ? undefined : declaration;
    };
    const tables = new Map<string, Map<string, Declaration>>();
    const declarations = (file: ts.SourceFile): Map<string, Declaration> => {
      const existing = tables.get(file.fileName);
      if (existing) return existing;
      const table = new Map<string, Declaration>();
      tables.set(file.fileName, table);
      // The module's own names: imports and top-level declarations.
      const names = file.statements.flatMap((statement): ReadonlyArray<ts.Node> =>
        ts.isImportDeclaration(statement) ? [statement.importClause?.name, ...(statement.importClause?.namedBindings
          ? ts.isNamespaceImport(statement.importClause.namedBindings) ? [statement.importClause.namedBindings.name]
            : statement.importClause.namedBindings.elements.map((element) => element.name) : [])].filter((name) => name !== undefined)
        : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map((declaration) => declaration.name)
        : (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name ? [statement.name]
        : ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) ? [statement.name] : []);
      const symbols = names.length > 0 ? checker.getSymbolAtLocation(names) : [];
      symbols.forEach((symbol, index) => {
        if (!symbol) return;
        const declaration = within(file, declarationOf(symbol, names[index]!.parent));
        if (declaration) table.set(symbol.name, declaration);
      });
      const moduleSymbol = checker.getSymbolOfSourceFile(file.fileName);
      for (const symbol of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
        if (table.has(symbol.name)) continue;
        const declaration = within(file, declarationOf(symbol, aliasDeclaration(symbol)));
        if (declaration) table.set(symbol.name, declaration);
      }
      const elements: ts.BindingElement[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isBindingElement(node) && node.name && ts.isIdentifier(node.name) && !node.dotDotDotToken && ts.isObjectBindingPattern(node.parent))
          elements.push(node);
        node.forEachChild(visit);
      };
      visit(file);
      const patterns = [...new Set(elements.map((element) => element.parent))];
      const types = new Map(patterns.length > 0 ? checker.getTypeAtLocation(patterns).map((type, index) => [patterns[index]!, type]) : []);
      for (const element of elements) {
        const name = (element.name as ts.Identifier).text;
        if (table.has(name)) continue;
        const declaration = within(file, destructuredExport(element, types.get(element.parent)));
        if (declaration) table.set(name, declaration);
      }
      return table;
    };
    const opened: Array<{ dispose: () => void }> = [];
    const openProjects = (configs: ReadonlyArray<string>) => {
      // Derived from the program's snapshot, so each project reuses its parsed files.
      const configured = snapshot.update({ createPrograms: configs.map((config) => {
        const parsed = api.parseConfigFile(config);
        return { rootFiles: parsed.fileNames, compilerOptions: { ...parsed.options, noEmit: true, paths: { ...parsed.options.paths, ...sourcePaths } } };
      }) });
      opened.push(configured);
      const projects = configured.operation.createdPrograms.map((program) => program.getProject());
      return (config: string) => projects[configs.indexOf(config)];
    };
    return {
      project, environment: observed.environment,
      readFile: observed.readFile,
      program, declarations, configFor: (file) => configFor(dirname(resolve(file))), openProjects,
      close: () => { for (const snapshot of opened) snapshot.dispose(); parsed.dispose(); api.close(); },
    };
  } catch (error) {
    api.close();
    throw error;
  }
};
