import { dirname, relative, resolve } from "node:path";
import { approvedServices, owners as boundaryOwners } from "../architecture/boundaries.mjs";
import { coreExports } from "../architecture/app.ts";
import { layout, undecided } from "../architecture/layout.mjs";
import { libraryRules } from "./library-rules.mjs";
import { structureRules } from "./structure-rules.mjs";
import { effectHygieneRules } from "./effect-hygiene-rules.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** Sources that can carry an owner's private names: core, and the CLI facades that re-export it. */
function carriesCoreNames(fileDirectory, source) {
  if (source === "@smolai/skit-core" || source.startsWith("@smolai/skit-core/")) return true;
  if (!source.startsWith(".")) return false;
  const target = relative(repositoryRoot, resolve(fileDirectory, source));
  return (
    target.startsWith("packages/skit/src/") ||
    /^packages\/cli\/src\/(front-end|library-application\/index)(\.js)?$/.test(target)
  );
}

const streamNames = new Set(["stdout", "stderr"]);

function containsProcessStream(node) {
  if (!node || typeof node !== "object") return false;
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property?.type === "Identifier" &&
    streamNames.has(node.property.name)
  )
    return true;
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      (Array.isArray(value)
        ? value.some(containsProcessStream)
        : value && typeof value === "object" && containsProcessStream(value)),
  );
}

function containsJsonParse(node) {
  if (!node || typeof node !== "object") return false;
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "JSON" &&
    node.callee.property?.type === "Identifier" &&
    node.callee.property.name === "parse" &&
    containsProcessStream(node.arguments[0])
  )
    return true;
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      (Array.isArray(value)
        ? value.some(containsJsonParse)
        : value && typeof value === "object" && containsJsonParse(value)),
  );
}

function isEmptyStreamAssertion(expectCall) {
  const matcher = expectCall.parent;
  const assertion = matcher?.parent;
  return (
    matcher?.type === "MemberExpression" &&
    assertion?.type === "CallExpression" &&
    assertion.callee === matcher &&
    ["toBe", "toEqual"].includes(matcher.property?.name) &&
    assertion.arguments.length === 1 &&
    assertion.arguments[0]?.type === "Literal" &&
    assertion.arguments[0].value === ""
  );
}

// An anonymous `Record<K, any>` / `Record<K, unknown>` describes "some object" rather than the
// boundary actually being crossed, so it survives refactors that change the data underneath it.
// The key type is irrelevant: the open value type is what defeats checking. Declare the fields
// the code reads, or give the boundary a named type (JsonObject, YamlMapping) that says what the
// arbitrary data actually is.
function recordValueRule(valueKeyword, valueLabel, remedy) {
  return {
    meta: {
      type: "problem",
      docs: { description: `Disallow anonymous Record<K, ${valueLabel}> dictionaries` },
      messages: {
        forbidden: `Do not use Record<K, ${valueLabel}>. ${remedy}`,
      },
    },
    create(context) {
      return {
        TSTypeReference(node) {
          if (node.typeName?.name !== "Record") return;
          const params = node.typeArguments?.params;
          if (params?.length !== 2 || params[1].type !== valueKeyword) return;
          context.report({ node, messageId: "forbidden" });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Effect v4 migration rules.
//
// These patterns preserve legacy runtime and Promise boundaries inside otherwise
// migrated code. They are banned mechanically so production and tests compose
// through the same native Effect services.
// ---------------------------------------------------------------------------

const runtimeEntryNames = new Set([
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit",
  "runFork",
]);
const runtimeHelperNames = new Set(["runSkit", "runSkitSync"]);
const effectCallbackNames = new Set(["fn", "gen", "fnUntraced"]);
const effectTestNames = new Set(["effect", "scoped", "live", "scopedLive"]);
const errorOperandNames = new Set(["error", "err", "cause", "failure", "e"]);

/**
 * `Effect.<name>` where the object is literally the `Effect` namespace, including the
 * curried `Effect.fn("span")(body)` form whose callee is itself a call.
 */
function isEffectMember(callee, names) {
  if (callee?.type === "CallExpression") return isEffectMember(callee.callee, names);
  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.object?.type === "Identifier" &&
    callee.object.name === "Effect" &&
    callee.property?.type === "Identifier" &&
    names.has(callee.property.name)
  );
}

/** Walks up `parent` pointers until `match` accepts a node, stopping at `stop`. */
function findAncestor(node, match, stop = () => false) {
  for (let current = node.parent; current; current = current.parent) {
    if (stop(current)) return undefined;
    if (match(current)) return current;
  }
  return undefined;
}

function isAsyncFunctionNode(node) {
  return isFunctionNode(node) && node.async === true;
}

function isFunctionNode(node) {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

function containsPredicateObjectGuard(node, subjectName) {
  if (!node || typeof node !== "object") return false;
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "Predicate" &&
    node.callee.property?.type === "Identifier" &&
    node.callee.property.name === "isObject" &&
    node.arguments[0]?.type === "Identifier" &&
    node.arguments[0].name === subjectName
  )
    return true;
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      (Array.isArray(value)
        ? value.some((item) => containsPredicateObjectGuard(item, subjectName))
        : value && typeof value === "object" && containsPredicateObjectGuard(value, subjectName)),
  );
}

/** `it(...)` / `test(...)` and their `.only`/`.skip`/`.each` variants — not `it.effect`. */
function isTestLauncherCall(node) {
  let callee = node.callee;
  while (
    callee?.type === "MemberExpression" &&
    callee.property?.type === "Identifier" &&
    ["only", "skip", "todo", "fails", "each", "concurrent", "sequential"].includes(
      callee.property.name,
    )
  )
    callee = callee.object;
  return callee?.type === "Identifier" && ["it", "test"].includes(callee.name);
}

/** `it.effect(...)`, `test.scoped(...)`, and the `.only`/`.skip` variants of both. */
function isEffectTestCall(node) {
  if (node.type !== "CallExpression") return false;
  let callee = node.callee;
  if (
    callee?.type === "MemberExpression" &&
    callee.property?.type === "Identifier" &&
    ["only", "skip", "fails", "each"].includes(callee.property.name)
  )
    callee = callee.object;
  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier" &&
    effectTestNames.has(callee.property.name)
  );
}

function containsJsonSource(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return false;
  if (node.type === "CallExpression") {
    const callee = node.callee;
    const jsonParse =
      callee?.type === "MemberExpression" &&
      callee.object?.type === "Identifier" &&
      callee.object.name === "JSON" &&
      callee.property?.name === "parse";
    const responseJson = callee?.type === "MemberExpression" && callee.property?.name === "json";
    if (jsonParse || responseJson) return true;
  }
  if (node.type === "AwaitExpression" || node.type === "TSNonNullExpression")
    return containsJsonSource(node.argument ?? node.expression, depth + 1);
  if (node.type === "YieldExpression") return containsJsonSource(node.argument, depth + 1);
  return false;
}

const effectRules = {
  "no-member-access-on-yield": {
    meta: {
      type: "suggestion",
      docs: { description: "Name yielded values before reading their members" },
      messages: {
        forbidden:
          "Name the yielded value first, then access its member. This keeps the Effect boundary and the transformation readable.",
      },
    },
    create(context) {
      return {
        MemberExpression(node) {
          if (node.object?.type === "YieldExpression")
            context.report({ node, messageId: "forbidden" });
        },
      };
    },
  },

  "no-run-skit": {
    meta: {
      type: "problem",
      docs: { description: "Retire the runSkit compatibility entry" },
      messages: {
        forbidden:
          "Do not call runSkit. It re-enters the runtime inside the application. Return the Effect and let the caller compose it.",
      },
    },
    create(context) {
      return {
        CallExpression(node) {
          if (node.callee?.type === "Identifier" && runtimeHelperNames.has(node.callee.name))
            context.report({ node, messageId: "forbidden" });
        },
      };
    },
  },

  "no-nested-runtime": {
    meta: {
      type: "problem",
      docs: { description: "Keep runtime entry at the process boundary" },
      messages: {
        forbidden:
          "Do not enter the Effect runtime here. Return the Effect and let the caller compose it; only the CLI entrypoint may run it.",
      },
    },
    create(context) {
      return {
        CallExpression(node) {
          if (isEffectMember(node.callee, runtimeEntryNames))
            context.report({ node, messageId: "forbidden" });
        },
      };
    },
  },

  "no-async-test-callback": {
    meta: {
      type: "problem",
      docs: { description: "Effect tests yield; they do not await" },
      messages: {
        forbidden:
          "Do not await in this suite. Use it.effect and yield* the workflow so the test runs as one Effect program against the same services production uses.",
      },
    },
    create(context) {
      return {
        AwaitExpression(node) {
          // An await inside a fetch double or an HTTP handler belongs to that callback, which
          // has to be async to satisfy the API it implements. Only an await in the test body
          // itself means the suite is not yielding, so stop at the first async function that is
          // not the test callback.
          const shielded = (ancestor) =>
            isAsyncFunctionNode(ancestor) && !isEffectTestCall(ancestor.parent);
          if (findAncestor(node, isEffectTestCall, shielded))
            context.report({ node, messageId: "forbidden" });
        },
        CallExpression(node) {
          if (!isTestLauncherCall(node)) return;
          for (const argument of node.arguments)
            if (isFunctionNode(argument) && argument.async === true)
              context.report({ node: argument, messageId: "forbidden" });
        },
      };
    },
  },

  "no-throw-in-effect": {
    meta: {
      type: "problem",
      docs: { description: "Effect bodies fail through the error channel" },
      messages: {
        forbidden:
          "Do not throw inside an Effect body. Fail with a tagged error through the declared error channel.",
      },
    },
    create(context) {
      // Only the nearest function owns this throw. Nested transport/mocked callbacks may
      // deliberately throw even when they are constructed inside an Effect generator.
      const inEffectCallback = (node) => {
        const owner = findAncestor(node, isFunctionNode);
        return (
          owner?.parent?.type === "CallExpression" &&
          isEffectMember(owner.parent.callee, effectCallbackNames)
        );
      };
      return {
        ThrowStatement(node) {
          if (inEffectCallback(node)) context.report({ node, messageId: "forbidden" });
        },
      };
    },
  },

  "no-error-instanceof": {
    meta: {
      type: "problem",
      docs: { description: "Discriminate failures by tag, not by prototype" },
      messages: {
        forbidden:
          "Do not branch on an error's prototype. Use catchTag/catchTags on the tagged failure.",
      },
    },
    create(context) {
      return {
        BinaryExpression(node) {
          if (node.operator !== "instanceof") return;
          // Extracting a native Error message for diagnostics is not failure recovery.
          const conditional = node.parent;
          if (
            node.right?.type === "Identifier" &&
            node.right.name === "Error" &&
            conditional?.type === "ConditionalExpression" &&
            conditional.test === node &&
            conditional.consequent?.type === "MemberExpression" &&
            !conditional.consequent.computed &&
            conditional.consequent.property?.name === "message" &&
            node.left?.type === "Identifier" &&
            conditional.consequent.object?.type === "Identifier" &&
            conditional.consequent.object.name === node.left.name
          )
            return;
          const subject = node.left?.type === "Identifier" && errorOperandNames.has(node.left.name);
          const constructor =
            node.right?.type === "Identifier" &&
            /(Error|Failed|Failure|Exception)$/.test(node.right.name);
          if (subject || constructor) context.report({ node, messageId: "forbidden" });
        },
      };
    },
  },

  "no-cast-parsed-json": {
    meta: {
      type: "problem",
      docs: { description: "Decode untrusted JSON instead of asserting its type" },
      messages: {
        forbidden:
          "Do not assert a type over parsed JSON. Decode it with Schema so malformed input fails the same way in tests and production.",
      },
    },
    create(context) {
      return {
        TSAsExpression(node) {
          if (containsJsonSource(node.expression)) context.report({ node, messageId: "forbidden" });
        },
      };
    },
  },

  "no-structural-object-probe": {
    meta: {
      type: "problem",
      docs: { description: "Decode unknown object fields instead of probing their presence" },
      messages: {
        forbidden:
          "Do not combine Predicate.isObject(value) with literal field probes. Decode the boundary with Schema.",
      },
    },
    create(context) {
      return {
        BinaryExpression(node) {
          if (
            node.operator !== "in" ||
            node.left?.type !== "Literal" ||
            typeof node.left.value !== "string" ||
            node.right?.type !== "Identifier"
          )
            return;
          for (let expression = node.parent; expression?.type === "LogicalExpression";) {
            if (containsPredicateObjectGuard(expression, node.right.name)) {
              context.report({ node, messageId: "forbidden" });
              return;
            }
            expression = expression.parent;
          }
        },
      };
    },
  },

  "no-handrolled-fetch-double": {
    meta: {
      type: "problem",
      docs: { description: "Stub HTTP through the client layer, not a fetch function" },
      messages: {
        forbidden:
          "Do not hand-roll a `typeof fetch` double. Provide a test HttpClient layer so the test exercises the same boundary as production.",
      },
    },
    create(context) {
      return {
        TSTypeQuery(node) {
          if (node.exprName?.type === "Identifier" && node.exprName.name === "fetch")
            context.report({ node, messageId: "forbidden" });
        },
      };
    },
  },

  "no-node-fs": {
    meta: {
      type: "problem",
      docs: { description: "Reach the filesystem through the platform seam" },
      messages: {
        forbidden:
          "Do not import node:fs. Use Effect's FileSystem service so the operation is scoped, typed, and swappable in tests.",
      },
    },
    create(context) {
      return {
        ImportDeclaration(node) {
          const source = node.source?.value;
          if (typeof source === "string" && source.startsWith("node:fs"))
            context.report({ node: node.source, messageId: "forbidden" });
        },
      };
    },
  },

  "owner-boundaries": {
    meta: {
      type: "problem",
      docs: { description: "Only an owner may use its private storage and writers" },
      messages: {
        forbidden:
          "{{name}} is private to {{owner}} (architecture/boundaries.mjs). Call {{owner}} instead.",
      },
    },
    create(context) {
      const file = relative(repositoryRoot, context.filename);
      const fileDirectory = dirname(context.filename);
      const owners = boundaryOwners.filter(
        (owner) => ![owner.owner].flat().some((path) => file.startsWith(path)),
      );
      if (owners.length === 0) return {};
      // An owner's names arrive through core (default) or through the modules listed in `sources`.
      const carries = (owner, source) => {
        if (owner.sources === undefined) return carriesCoreNames(fileDirectory, source);
        if (!source.startsWith(".")) return false;
        const target = relative(repositoryRoot, resolve(fileDirectory, source));
        return owner.sources.some((path) => target.startsWith(path));
      };
      const check = (node) => {
        const source = node.source?.value;
        if (typeof source !== "string") return;
        // Whole modules can be private: renaming an exported helper must not open a new bypass.
        const declared = source.startsWith("@smolai/skit-core/")
          ? coreExports[`./${source.slice("@smolai/skit-core/".length)}`]
          : undefined;
        const target = source.startsWith(".")
          ? relative(repositoryRoot, resolve(fileDirectory, source))
          : declared?.source;
        const moduleOwner = owners.find(
          (owner) =>
            target !== undefined &&
            !(source.startsWith(".") && file.startsWith(owner.testOwner ?? "\0")) &&
            owner.privateModules?.some((prefix) => target.startsWith(prefix)),
        );
        if (moduleOwner) {
          context.report({
            node,
            messageId: "forbidden",
            data: { name: source, owner: moduleOwner.name },
          });
          return;
        }
        // Package-local unit tests may name helpers only through their actual private module.
        // Public barrels and compatibility paths carry no test authority.
        const reachable = owners.filter(
          (owner) =>
            carries(owner, source) &&
            !(
              target !== undefined &&
              source.startsWith(".") &&
              file.startsWith(owner.testOwner ?? "\0") &&
              owner.privateModules?.some((prefix) => target.startsWith(prefix))
            ),
        );
        if (reachable.length === 0) return;
        for (const specifier of node.specifiers ?? []) {
          const imported = specifier.imported ?? specifier.local;
          const name = imported?.type === "Identifier" ? imported.name : imported?.value;
          if (typeof name !== "string") continue;
          const owner = reachable.find((candidate) => candidate.private.includes(name));
          if (owner)
            context.report({
              node: specifier,
              messageId: "forbidden",
              data: { name, owner: owner.name },
            });
        }
      };
      return {
        ImportDeclaration: check,
        ExportNamedDeclaration: check,
        ExportAllDeclaration: check,
        ImportExpression: check,
      };
    },
  },

  "approved-services": {
    meta: {
      type: "problem",
      docs: { description: "Only services the architecture model approves may exist" },
      messages: {
        forbidden:
          "{{id}} is not an approved service (architecture/boundaries.mjs). A service must own state or hold a resource; otherwise write a plain function. New services are an architecture change.",
      },
    },
    create(context) {
      const known = new Set(approvedServices);
      const isContext = (callee, member) =>
        callee?.type === "MemberExpression" &&
        !callee.computed &&
        callee.object?.type === "Identifier" &&
        callee.object.name === "Context" &&
        callee.property?.name === member;
      return {
        CallExpression(node) {
          const id = node.arguments[0];
          if (id?.type !== "Literal" || typeof id.value !== "string") return;
          const declares =
            isContext(node.callee, "Reference") ||
            (node.callee?.type === "CallExpression" && isContext(node.callee.callee, "Service"));
          if (declares && !known.has(id.value))
            context.report({ node: id, messageId: "forbidden", data: { id: id.value } });
        },
      };
    },
  },

  "directory-layout": {
    meta: {
      type: "problem",
      docs: { description: "Source files live in the target folder layout" },
      messages: {
        forbidden:
          "{{file}} is outside the target layout for {{package}} (architecture/layout.mjs). Put it in one of: {{allowed}}.",
      },
    },
    create(context) {
      const file = relative(repositoryRoot, context.filename);
      const source = Object.keys(layout).find((path) => file.startsWith(path));
      if (source === undefined) return {};
      if (undecided.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)))
        return {};
      const target = layout[source];
      const [top, ...rest] = file.slice(source.length).split("/");
      if (rest.length === 0 ? target.files.includes(top) : target.folders.includes(top)) return {};
      return {
        Program() {
          context.report({
            loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
            messageId: "forbidden",
            data: {
              file,
              package: source,
              allowed: [...target.files, ...target.folders.map((folder) => `${folder}/`)].join(
                ", ",
              ),
            },
          });
        },
      };
    },
  },

  "import-direction": {
    meta: {
      type: "problem",
      docs: { description: "Imports follow the target layout's direction" },
      messages: {
        coreRoot: "The core root entry is removed. Import a declared owner or shared subpath.",
        installedPolicy:
          "Installed-skill file adapters consume copy/identity facts, not Library state or owner policy. Move retained-version decisions into Library (architecture/app.ts).",
        frontend:
          "{{target}} is CLI source. The TUI imports core public APIs; Storybook may also use the CLI public story export, never CLI source (architecture/layout.mjs).",
        internal:
          "{{target}} is internal to {{owner}}. Only code under {{owner}} may import it; call the owner's public module instead (architecture/layout.mjs).",
      },
    },
    create(context) {
      const file = relative(repositoryRoot, context.filename);
      const fileDirectory = dirname(context.filename);
      const frontend =
        file.startsWith("packages/tui/src/") || file.startsWith("packages/storybook/");
      const check = (node, sourceNode) => {
        const source = sourceNode?.value;
        if (typeof source !== "string") return;
        const cliPackage = source === "@smolai/skit" || source.startsWith("@smolai/skit/");
        if (
          frontend &&
          cliPackage &&
          !(file.startsWith("packages/storybook/") && source === "@smolai/skit/storybook")
        ) {
          context.report({ node: sourceNode, messageId: "frontend", data: { target: source } });
          return;
        }
        const target = source.startsWith(".")
          ? relative(repositoryRoot, resolve(fileDirectory, source)).replace(/\.js$/, "")
          : source.startsWith("@smolai/skit-core/")
            ? `packages/skit/src/${source.slice("@smolai/skit-core/".length)}`
            : undefined;
        if (
          source === "@smolai/skit-core" ||
          target?.replace(/\.[jt]s$/, "") === "packages/skit/src/index"
        ) {
          context.report({ node: sourceNode, messageId: "coreRoot" });
          return;
        }
        const declared = source.startsWith("@smolai/skit-core/")
          ? coreExports[`./${source.slice("@smolai/skit-core/".length)}`]
          : undefined;
        const policyTarget = (declared?.source ?? target)?.replace(/\.[jt]s$/, "");
        if (
          file.startsWith("packages/skit/src/installed-skills/") &&
          (policyTarget === "packages/skit/src/library" ||
            policyTarget?.startsWith("packages/skit/src/library/")) &&
          ![
            "packages/skit/src/library/device-state",
            "packages/skit/src/library/entity-ids",
          ].includes(policyTarget)
        ) {
          context.report({ node: sourceNode, messageId: "installedPolicy" });
          return;
        }
        if (target === undefined) return;
        if (frontend && source.startsWith(".") && target.startsWith("packages/cli/src/"))
          context.report({ node: sourceNode, messageId: "frontend", data: { target } });
        const internal = /^(packages\/skit\/src\/[^/]+\/)internal(?:\/|$)/.exec(target);
        // Package-local unit tests may exercise their owner's private implementation.
        const packageTest = file.startsWith("packages/skit/test/");
        if (internal && !file.startsWith(internal[1]) && !packageTest)
          context.report({
            node: sourceNode,
            messageId: "internal",
            data: { target, owner: internal[1] },
          });
      };
      const declaration = (node) => check(node, node.source);
      return {
        ImportDeclaration: declaration,
        ExportNamedDeclaration: declaration,
        ExportAllDeclaration: declaration,
        ImportExpression: (node) => check(node, node.source),
      };
    },
  },
};

export default {
  meta: { name: "skit" },
  rules: {
    ...effectRules,
    ...effectHygieneRules,
    ...libraryRules,
    ...structureRules,
    "no-direct-cli-output": {
      meta: {
        type: "problem",
        docs: { description: "Keep CLI output writes inside Renderer and Prompter" },
        messages: { forbidden: "Write CLI output through Renderer or Prompter, not directly." },
      },
      create(context) {
        return {
          MemberExpression(node) {
            const directConsole =
              node.object?.type === "Identifier" && node.object.name === "console";
            const directProcessStream =
              node.object?.type === "Identifier" &&
              node.object.name === "process" &&
              node.property?.type === "Identifier" &&
              streamNames.has(node.property.name) &&
              node.parent?.type === "MemberExpression" &&
              node.parent.object === node &&
              node.parent.property?.name === "write";
            if (directConsole || directProcessStream)
              context.report({ node, messageId: "forbidden" });
          },
        };
      },
    },
    "no-record-any": recordValueRule(
      "TSAnyKeyword",
      "any",
      "Declare an interface for the fields you read, or name the boundary (JsonObject, YamlMapping).",
    ),
    "no-record-unknown": recordValueRule(
      "TSUnknownKeyword",
      "unknown",
      "Declare an interface for the fields you read, or name the boundary (JsonObject, YamlMapping).",
    ),
    "no-cli-output-text-assertions": {
      meta: {
        type: "problem",
        docs: {
          description: "Require CLI subprocess output assertions to use structured JSON",
        },
        messages: {
          forbidden:
            "Do not assert against CLI stdout/stderr text. Parse structured JSON or assert that the stream is empty.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (node.callee?.type !== "Identifier" || node.callee.name !== "expect") return;
            const subject = node.arguments[0];
            if (
              !containsProcessStream(subject) ||
              containsJsonParse(subject) ||
              isEmptyStreamAssertion(node)
            )
              return;
            context.report({ node: subject, messageId: "forbidden" });
          },
        };
      },
    },
  },
};
