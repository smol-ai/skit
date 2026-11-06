import { relative, resolve } from "node:path";
import ts from "typescript-parser";
import { coreExports } from "../architecture/app.ts";
import { contains, effectImports } from "./effect-hygiene-rules.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = "packages/cli/src/";
// Every published core owner is an entry point here. Contracts and platform wiring are not owners:
// reading configuration or decoding a wire schema beside one owner call is not orchestration.
const vocabulary = new Set([
  "./shared",
  "./api",
  "./universal/api",
  "./platform",
]);
const ownerEntries = new Set(
  Object.keys(coreExports)
    .filter((subpath) => !vocabulary.has(subpath))
    .map((subpath) => `@smolai/skit-core/${subpath.slice(2)}`),
);
const member = (node) =>
  node?.type === "MemberExpression"
    ? node.computed
      ? node.property?.value
      : node.property?.name
    : node?.type === "TSQualifiedName"
      ? node.right?.name
      : undefined;
const object = (node) => node?.object ?? node?.left;
const isFunction = (node) =>
  [
    "FunctionExpression",
    "ArrowFunctionExpression",
    "FunctionDeclaration",
  ].includes(node?.type);

/** Visit work executed by this body, leaving callbacks to their own Effect body check. */
function walkBody(node, visit) {
  if (!node || typeof node !== "object" || isFunction(node)) return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) value.forEach((child) => walkBody(child, visit));
    else walkBody(value, visit);
  }
}

/** Track real imported API names, including aliases and submodule namespace imports. */
function imports() {
  const names = new Map();
  return {
    add(node) {
      for (const specifier of node.specifiers) {
        names.set(specifier.local.name, {
          source: node.source.value,
          name:
            specifier.type === "ImportNamespaceSpecifier"
              ? "*"
              : specifier.imported?.name,
        });
      }
    },
    path(node) {
      if (!node) return undefined;
      if (node?.type === "Identifier") {
        const binding = names.get(node.name);
        return (
          binding && [
            binding.source,
            ...(binding.name === "*" ? [] : [binding.name]),
          ]
        );
      }
      const parent = this.path(object(node));
      return parent && member(node) !== undefined
        ? [...parent, member(node)]
        : undefined;
    },
  };
}

/** TypeScript resolves aliases, re-exports and inheritance; spelling is not error evidence. */
let cliProgram;
function cliTypes(context) {
  const filename = context.filename;
  // Oxlint visits many files in one process. Resolve their shared graph only once. Refresh
  // if a host reuses the plugin for edited source (e.g. a subsequent editor lint pass).
  if (cliProgram?.getSourceFile(filename)?.text !== context.sourceCode.text) {
    const config = ts.readConfigFile(
      resolve(root, "packages/cli/tsconfig.json"),
      ts.sys.readFile,
    );
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      resolve(root, "packages/cli"),
    );
    const host = ts.createCompilerHost(parsed.options);
    const read = host.readFile;
    host.readFile = (file) =>
      file === filename ? context.sourceCode.text : read(file);
    // Inspect current core source, never declarations from a previous dist/ build.
    host.resolveModuleNameLiterals = (
      literals,
      from,
      redirected,
      options,
      source,
    ) =>
      literals.map((literal) => {
        const entry = literal.text.startsWith("@smolai/skit-core/")
          ? coreExports[`./${literal.text.slice("@smolai/skit-core/".length)}`]
          : undefined;
        return entry
          ? {
              resolvedModule: {
                resolvedFileName: resolve(root, entry.source),
                extension: ts.Extension.Ts,
              },
            }
          : ts.resolveModuleName(
              literal.text,
              from,
              options,
              host,
              undefined,
              redirected,
              ts.getModeForUsageLocation(source, literal, options),
            );
      });
    cliProgram = ts.createProgram(
      [
        ...new Set([
          ...parsed.fileNames.filter((file) =>
            file.startsWith(resolve(root, cli) + "/"),
          ),
          filename,
        ]),
      ],
      { ...parsed.options, noEmit: true },
      host,
    );
  }
  const program = cliProgram;
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(filename);
  return { checker, source };
}

function failureUnions(context) {
  const { checker, source } = cliTypes(context);
  const error = checker.resolveName(
    "Error",
    source,
    ts.SymbolFlags.Type,
    false,
  );
  const errorType = error && checker.getDeclaredTypeOfSymbol(error);
  const reports = [];
  const report = (node) =>
    reports.push({
      start: node.getStart(source),
      end: node.end,
    });
  const taggedErrors = (type) =>
    type.isUnion() &&
    type.types.every(
      (part) =>
        part.getProperty("_tag") &&
        errorType &&
        checker.isTypeAssignableTo(part, errorType),
    );
  const exported = new Set(
    source.symbol
      ? checker
          .getExportsOfModule(source.symbol)
          .map((symbol) =>
            symbol.flags & ts.SymbolFlags.Alias
              ? checker.getAliasedSymbol(symbol)
              : symbol,
          )
      : [],
  );
  const visit = (node) => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      exported.has(checker.getSymbolAtLocation(node.name)) &&
      ts.isUnionTypeNode(node.type) &&
      taggedErrors(checker.getTypeAtLocation(node.type))
    )
      report(node.type);
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isQualifiedName(node.typeName) &&
      node.typeName.right.text === "Return" &&
      ts.isQualifiedName(node.typeName.left) &&
      node.typeName.left.right.text === "fn"
    ) {
      const symbol = checker.getSymbolAtLocation(node.typeName.left.left);
      const effect = symbol?.declarations?.some(
        (declaration) =>
          (ts.isImportSpecifier(declaration) &&
            (declaration.propertyName ?? declaration.name).text === "Effect" &&
            declaration.parent.parent.parent.moduleSpecifier.text ===
              "effect") ||
          (ts.isNamespaceImport(declaration) &&
            ["effect/Effect", "effect/Effect.js"].includes(
              declaration.parent.parent.moduleSpecifier.text,
            )),
      );
      const failure = node.typeArguments?.[1];
      if (effect && failure && checker.getTypeAtLocation(failure).isUnion())
        report(failure);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reports;
}

/** Pure labels/choices exported beside owner operations do not perform owner work. */
function ownerEffectCalls(context, calls) {
  const { checker, source } = cliTypes(context);
  const starts = new Set(calls.map((call) => call.range[0]));
  let count = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node) && starts.has(node.getStart(source))) {
      const signature = checker.getResolvedSignature(node);
      const result = signature && checker.getReturnTypeOfSignature(signature);
      if (
        !result ||
        result.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ||
        result.getProperty("~effect/Effect")
      )
        count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function commandExport(context, exports) {
  const { checker, source } = cliTypes(context);
  const values = new Map(
    exports
      .filter((item) => item.value)
      .map((item) => [item.value.range[0], item]),
  );
  let command;
  const visit = (node) => {
    const item = values.get(node.getStart(source));
    if (
      item &&
      checker.getTypeAtLocation(node).getProperty("~effect/cli/Command")
    )
      command ??= item;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return command;
}

export const frontendRules = {
  "frontend-no-library-service": {
    meta: {
      type: "problem",
      docs: {
        description:
          "Frontends call Library operations; one root constructs the Library",
      },
      messages: {
        forbidden:
          "Library.{{name}} is the owner's own. Call a Library operation from @smolai/skit-core/library/session instead.",
      },
    },
    create(context) {
      const file = relative(root, context.filename);
      if (
        !file.startsWith(cli) ||
        /^(storybook|platform)\//.test(file.slice(cli.length))
      )
        return {};
      const bindings = imports();
      // The executable composes its one Library in commands/handler.ts; nothing else constructs one.
      const owned = new Set(
        file === `${cli}commands/handler.ts`
          ? ["Service", "Interface"]
          : ["Service", "layer", "Interface"],
      );
      const report = (node, name) =>
        context.report({ node, messageId: "forbidden", data: { name } });
      return {
        ImportDeclaration(node) {
          bindings.add(node);
          if (node.source.value !== "@smolai/skit-core/library") return;
          for (const specifier of node.specifiers)
            if (
              specifier.type === "ImportSpecifier" &&
              owned.has(specifier.imported?.name)
            )
              report(specifier, specifier.imported.name);
        },
        MemberExpression(node) {
          const path = bindings.path(node);
          if (
            path?.length === 2 &&
            path[0] === "@smolai/skit-core/library" &&
            owned.has(path[1])
          )
            report(node, path[1]);
        },
      };
    },
  },
  "frontend-no-resources": {
    meta: {
      type: "problem",
      docs: {
        description: "Frontends call owners instead of acquiring resources",
      },
      messages: {
        forbidden:
          "Resource access belongs to an owner. Call the owner and render its result.",
      },
    },
    create(context) {
      const file = relative(root, context.filename);
      if (
        !file.startsWith(cli) ||
        /^(registry|platform|terminal)\//.test(file.slice(cli.length))
      )
        return {};
      const bindings = imports();
      const resource = (node) => {
        const path = bindings.path(node)?.join("/");
        return [
          "effect/FileSystem/FileSystem",
          "effect/Effect/acquireRelease",
          "effect/process/ChildProcessSpawner",
          "effect/process/ChildProcessSpawner/ChildProcessSpawner",
        ].includes(path);
      };
      return {
        ImportDeclaration(node) {
          bindings.add(node);
          if (
            /^(?:node:)?(?:fs(?:\/|$)|crypto$)/.test(node.source.value) ||
            node.source.value === "effect/process/ChildProcessSpawner" ||
            (node.source.value === "effect/process" &&
              node.specifiers.some(
                (s) => s.imported?.name === "ChildProcessSpawner",
              ))
          )
            context.report({ node, messageId: "forbidden" });
        },
        ImportExpression(node) {
          if (/^(?:node:)?(?:fs(?:\/|$)|crypto$)/.test(node.source.value ?? ""))
            context.report({ node, messageId: "forbidden" });
        },
        MemberExpression(node) {
          if (resource(node) && !resource(node.parent))
            context.report({ node, messageId: "forbidden" });
        },
        YieldExpression(node) {
          if (node.argument?.type === "Identifier" && resource(node.argument))
            context.report({ node, messageId: "forbidden" });
        },
        CallExpression(node) {
          if (node.callee?.type === "Identifier" && resource(node.callee))
            context.report({ node, messageId: "forbidden" });
        },
        TSTypeReference(node) {
          if (resource(node.typeName))
            context.report({ node, messageId: "forbidden" });
          const name = node.typeName;
          const path = bindings.path(name)?.join("/");
          const requirement =
            path === "effect/Effect/fn/Return"
              ? 2
              : path === "effect/Effect/Effect"
                ? 2
                : undefined;
          const r =
            requirement === undefined
              ? undefined
              : node.typeArguments?.params[requirement];
          if (
            r &&
            contains(
              r,
              (child) =>
                child.type === "TSTypeReference" &&
                bindings.path(child.typeName)?.join("/") ===
                  "effect/Scope/Scope",
            )
          )
            context.report({ node: r, messageId: "forbidden" });
        },
      };
    },
  },
  "frontend-one-owner-call": {
    meta: {
      type: "problem",
      docs: {
        description: "A frontend Effect body delegates to one owner operation",
      },
      messages: {
        forbidden:
          "This Effect body yields multiple owner calls. Move their coordination into the owner.",
      },
    },
    create(context) {
      if (
        !/^packages\/cli\/src\/(author|library|feedback|commands)\//.test(
          relative(root, context.filename),
        )
      )
        return {};
      const effect = effectImports();
      const bindings = imports();
      return {
        ImportDeclaration(node) {
          effect.ImportDeclaration(node);
          bindings.add(node);
        },
        CallExpression(node) {
          const callee =
            node.callee?.type === "CallExpression"
              ? node.callee.callee
              : node.callee;
          if (!["fn", "gen"].some((name) => effect.is(callee, name))) return;
          for (const callback of node.arguments.filter(isFunction)) {
            const calls = [];
            walkBody(callback.body, (child) => {
              if (child.type !== "YieldExpression" || !child.delegate) return;
              walkBody(child.argument, (call) => {
                if (
                  call.type === "CallExpression" &&
                  ownerEntries.has(bindings.path(call.callee)?.[0])
                )
                  calls.push(call);
              });
            });
            if (calls.length > 1 && ownerEffectCalls(context, calls) > 1)
              context.report({ node: callback, messageId: "forbidden" });
          }
        },
      };
    },
  },
  "no-failure-unions": {
    meta: {
      type: "problem",
      docs: {
        description:
          "Infer workflow failures instead of maintaining step-list unions",
      },
      messages: {
        forbidden:
          "Infer the operation's failures instead of maintaining a handwritten failure union.",
      },
    },
    create(context) {
      if (!relative(root, context.filename).startsWith(cli)) return {};
      return {
        Program(node) {
          // Most CLI files need no compiler work. Resolve only files with union or Return syntax.
          if (
            !contains(
              node,
              (child) =>
                child.type === "TSUnionType" ||
                (child.type === "TSQualifiedName" &&
                  child.right?.name === "Return"),
            )
          )
            return;
          for (const span of failureUnions(context))
            context.report({
              loc: {
                start: context.sourceCode.getLocFromIndex(span.start),
                end: context.sourceCode.getLocFromIndex(span.end),
              },
              messageId: "forbidden",
            });
        },
      };
    },
  },
  "command-module-exports": {
    meta: {
      type: "problem",
      docs: {
        description: "A command declaration module exports only its command",
      },
      messages: {
        forbidden:
          "A Command.make module exports only its command. Move helpers and types into the feature module.",
      },
    },
    create(context) {
      if (!relative(root, context.filename).startsWith(cli)) return {};
      const bindings = imports();
      return {
        ImportDeclaration: (node) => bindings.add(node),
        "Program:exit"(node) {
          const declarations = new Map();
          const exports = [];
          for (const statement of node.body) {
            const declaration = statement.declaration ?? statement;
            if (declaration.type === "VariableDeclaration")
              for (const variable of declaration.declarations)
                declarations.set(variable.id.name, variable.init);
            if (statement.type === "ExportAllDeclaration")
              exports.push({ node: statement });
            if (statement.type === "ExportDefaultDeclaration")
              exports.push({ node: statement, value: declaration });
            if (statement.type !== "ExportNamedDeclaration") continue;
            if (statement.declaration) {
              if (declaration.type === "VariableDeclaration")
                for (const variable of declaration.declarations)
                  exports.push({ node: variable, value: variable.init });
              else exports.push({ node: declaration });
            }
            for (const specifier of statement.specifiers)
              exports.push({
                node: specifier,
                value: specifier.local,
              });
          }
          const isCommand = (value, seen = new Set()) => {
            if (value?.type === "Identifier") {
              if (seen.has(value.name)) return false;
              seen.add(value.name);
              return isCommand(declarations.get(value.name), seen);
            }
            let found = false;
            walkBody(value, (child) => {
              if (
                child.type === "CallExpression" &&
                bindings.path(child.callee)?.join("/") ===
                  "effect/cli/Command/make"
              )
                found = true;
            });
            return found;
          };
          const command =
            exports.find((item) => isCommand(item.value)) ??
            (exports.length > 1 ? commandExport(context, exports) : undefined);
          if (command)
            for (const item of exports)
              if (item !== command)
                context.report({ node: item.node, messageId: "forbidden" });
        },
      };
    },
  },
};
