/** Recognize Effect imports, including named aliases and effect/Effect namespaces. */
function effectImports() {
  const namespaces = new Set(["Effect"]);
  const members = new Map();
  return {
    ImportDeclaration(node) {
      const source = node.source.value;
      for (const specifier of node.specifiers) {
        if (
          (source === "effect" && specifier.imported?.name === "Effect") ||
          ((source === "effect/Effect" || source === "effect/Effect.js") &&
            specifier.type === "ImportNamespaceSpecifier")
        )
          namespaces.add(specifier.local.name);
        if (source === "effect/Effect" && specifier.type === "ImportSpecifier")
          members.set(specifier.local.name, specifier.imported.name);
      }
    },
    is(node, name) {
      if (node?.type === "Identifier") return members.get(node.name) === name;
      return (
        node?.type === "MemberExpression" &&
        node.object.type === "Identifier" &&
        namespaces.has(node.object.name) &&
        (node.computed ? node.property.value : node.property.name) === name
      );
    },
  };
}

function contains(node, predicate) {
  if (!node || typeof node !== "object") return false;
  if (predicate(node)) return true;
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      (Array.isArray(value)
        ? value.some((item) => contains(item, predicate))
        : contains(value, predicate)),
  );
}

/** Module loading has no native Effect equivalent; do not exempt arbitrary Promise work. */
function importsModule(callback) {
  return (
    callback?.type === "ArrowFunctionExpression" &&
    !callback.async &&
    callback.body.type === "ImportExpression" &&
    callback.body.source.type === "Literal" &&
    typeof callback.body.source.value === "string"
  );
}

export const effectHygieneRules = {
  "no-promise-wrappers": {
    meta: {
      type: "problem",
      docs: { description: "Use native Effect operations except for direct module loading" },
      messages: {
        forbidden:
          "Do not wrap a Promise back into an Effect. Use FileSystem, HttpClient, or the owning service. A direct dynamic import is a module-loading boundary.",
      },
    },
    create(context) {
      const effect = effectImports();
      return {
        ImportDeclaration: effect.ImportDeclaration,
        CallExpression(node) {
          if (effect.is(node.callee, "promise") && importsModule(node.arguments[0])) return;
          if (effect.is(node.callee, "promise") || effect.is(node.callee, "tryPromise"))
            context.report({ node, messageId: "forbidden" });
        },
      };
    },
  },
  "no-unconditional-cause-recovery": {
    meta: {
      type: "problem",
      docs: { description: "Require an explicit propagation path when recovering a full Cause" },
      messages: {
        forbidden:
          "Use Effect.catch/catchTag for expected failures. A catchCause handler must explicitly propagate its original cause with Effect.failCause; logging and succeeding also hides defects and interruption.",
      },
    },
    create(context) {
      const effect = effectImports();
      return {
        ImportDeclaration: effect.ImportDeclaration,
        CallExpression(node) {
          if (!effect.is(node.callee, "catchCause")) return;
          // Both catchCause(handler) and catchCause(program, handler) are supported.
          const handler = node.arguments.at(-1);
          const cause = handler?.params?.[0];
          const propagates =
            cause?.type === "Identifier" &&
            contains(
              handler.body,
              (child) =>
                child.type === "CallExpression" &&
                effect.is(child.callee, "failCause") &&
                child.arguments[0]?.type === "Identifier" &&
                child.arguments[0].name === cause.name,
            );
          if (!propagates) context.report({ node, messageId: "forbidden" });
        },
      };
    },
  },
};
