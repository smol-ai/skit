import { dirname, relative, resolve } from "node:path";
import { owners } from "../architecture/boundaries.mjs";

const root = resolve(import.meta.dirname, "..");
const library = "packages/skit/src/library/";
const libraryOwner = owners.find((owner) => owner.name === "Library");
const privateNames = new Set([
  ...libraryOwner.private,
  "LibraryStore",
  "libraryStoreLayer",
  "LibraryWriter",
  "writeLibrary",
  "withLibraryWriter",
  "CurrentLibraryAction",
  "CurrentLibraryWriter",
  "lastSavedLibraryState",
  "localLibrary",
  "recordedLibrary",
]);

const nameOf = (node) => node?.name ?? node?.value;
const typeOnly = (node, specifier) =>
  node.importKind === "type" ||
  node.exportKind === "type" ||
  specifier?.importKind === "type" ||
  specifier?.exportKind === "type";

function targetOf(filename, source) {
  if (typeof source !== "string") return undefined;
  if (source === "@smolai/skit-core") return "packages/skit/src/index";
  if (source === "@smolai/skit-core/library") return `${library}index`;
  if (source.startsWith("@smolai/skit-core/"))
    return `packages/skit/src/${source.slice("@smolai/skit-core/".length)}`;
  if (!source.startsWith(".")) return undefined;
  return relative(root, resolve(dirname(filename), source)).replace(/\.[cm]?[jt]sx?$/, "");
}

function declarations(check) {
  return {
    ImportDeclaration: (node) => check(node, false),
    ExportNamedDeclaration: (node) => check(node, true),
    ExportAllDeclaration: (node) => check(node, true),
    ImportExpression: (node) => check(node, false),
  };
}

// These are execution edges, not debt allowances. The recorded setup runner calls its step
// executors; the public owner must not call a folder executor directly. This does not prove
// that a recorded step is replay-safe: interruption/folder-evidence tests still establish that.
// Before: runtime -> apply-plan, undo -> undo-files, writer exit -> audit append.
// Required: runtime -> recorded operation -> step executor; persisted history -> delivery.
const executionEdges = [
  {
    module: `${library}apply-plan`,
    names: ["apply"],
    callers: [
      `${library}setup-manage.ts`,
      `${library}installed-update.ts`,
      `${library}internal/sync/operation.ts`,
    ],
  },
  {
    module: `${library}installed-update`,
    names: ["updateInstalledSkills"],
    callers: [`${library}setup-manage.ts`],
  },
  {
    module: `${library}setup-manage`,
    names: ["runManage", "runUpdate"],
    callers: [`${library}setup.ts`],
  },
  {
    module: `${library}setup-moves`,
    names: ["moveAside"],
    callers: [`${library}setup.ts`, `${library}setup-manage.ts`],
  },
  {
    module: `${library}internal/setup/undo-files`,
    names: ["prepareSetupUndoFiles"],
    callers: [`${library}setup.ts`],
  },
  {
    module: `${library}internal/recovery/moves`,
    names: ["prepareRecoveryRestore"],
    callers: [`${library}setup.ts`],
  },
  {
    module: `${library}audit/audit-log`,
    names: ["appendLibraryAudit"],
    callers: [`${library}store/state-file.ts`],
  },
];

// A wildcard re-export from these mixed modules exposes storage/writes as well as vocabulary.
// Named data/error exports stay available; implementation entry points do not.
const privateExportModules = new Set([
  `${library}import-collection`,
  `${library}collection-version`,
  `${library}inventory/refresh`,
  `${library}library-restore`,
  `${library}installation/install-enabled`,
  `${library}installation/remove`,
  `${library}installation/uninstall`,
  `${library}internal/recovery/moves`,
]);

const storageModule = (target) =>
  [
    "store/library-store",
    "store/state-file",
    "store/writer-lock",
    "store/manifest-v7",
    "store/state-schema-v9",
  ].some((module) => target === `${library}${module}`);

export const libraryRules = {
  "library-contract-complete": {
    meta: {
      type: "problem",
      docs: {
        description: "Library conformance has no whole-method exemptions or placeholder vocabulary",
      },
      messages: {
        debt: "{{name}} exempts Library from its approved contract. Close the implementation gap, or review a concrete contract correction separately; the debt type must be never.",
        placeholder:
          "Replace Library's Ref placeholder with concrete vocabulary. Placeholder contracts cannot establish exact implementation conformance.",
      },
    },
    create(context) {
      const file = relative(root, context.filename);
      if (!file.startsWith("architecture/")) return {};
      return {
        TSTypeAliasDeclaration(node) {
          if (file.startsWith("architecture/library") && node.id.name === "Ref")
            context.report({ node, messageId: "placeholder" });
          if (
            file.startsWith("architecture/conformance/library") &&
            ["MissingDebt", "ExtraDebt", "ChangedDebt", "RequirementDebt"].includes(node.id.name) &&
            node.typeAnnotation.type !== "TSNeverKeyword"
          )
            context.report({ node, messageId: "debt", data: { name: node.id.name } });
        },
        TSInterfaceDeclaration(node) {
          if (file.startsWith("architecture/library") && node.id.name === "Ref")
            context.report({ node, messageId: "placeholder" });
        },
      };
    },
  },

  "library-private-api": {
    meta: {
      type: "problem",
      docs: {
        description:
          "Library callers and public barrels have no legacy writer or constructor escape hatch",
      },
      messages: {
        private:
          "{{name}} exposes Library's private implementation. Call Library's public owner API; this completion rule has no migration-debt exemptions.",
        wildcard:
          "{{name}} exports Library implementation through a wildcard or namespace. Export the public vocabulary explicitly, without storage, writers or recovery callbacks.",
        constructor:
          "Library.make bypasses the single Library.layer constructor. Keep raw construction private to the owner runtime.",
        installed:
          "InstalledSkills.{{name}} is a Library-only capability. Call Library for changes; callers may inspect installed-skill facts.",
      },
    },
    create(context) {
      const file = relative(root, context.filename);
      if (!file.startsWith("packages/") || !file.includes("/src/")) return {};
      const inside = file.startsWith(library);
      const publicEntry =
        file === `${library}library.ts` ||
        file === `${library}index.ts` ||
        file === "packages/skit/src/index.ts";
      const coreNamespaces = new Set();
      const libraryNamespaces = new Set();
      const installedNamespaces = new Set();
      const installedInstances = new Set();
      const isInstalledNamespace = (node) =>
        installedNamespaces.has(node?.name) ||
        (node?.type === "MemberExpression" &&
          (coreNamespaces.has(node.object?.name) || libraryNamespaces.has(node.object?.name)) &&
          nameOf(node.property) === "InstalledSkills");
      const installedService = (node) =>
        node?.type === "YieldExpression" &&
        node.argument?.type === "MemberExpression" &&
        isInstalledNamespace(node.argument.object) &&
        nameOf(node.argument.property) === "Service";
      const installedInstance = (node) =>
        installedInstances.has(node?.name) || installedService(node);
      const check = (node, exporting) => {
        const target = targetOf(context.filename, node.source?.value);
        if (!target?.startsWith("packages/skit/src/")) return;
        if (node.importKind === "type" || node.exportKind === "type") return;
        if (
          node.specifiers?.length &&
          node.specifiers.every((specifier) => typeOnly(node, specifier))
        )
          return;
        const publicSource =
          target === "packages/skit/src/index" ||
          target === `${library}library` ||
          target === `${library}index`;
        if (node.type === "ImportDeclaration")
          for (const specifier of node.specifiers) {
            if (typeOnly(node, specifier) || !publicSource) continue;
            if (nameOf(specifier.imported) === "InstalledSkills")
              installedNamespaces.add(specifier.local.name);
            else if (
              nameOf(specifier.imported) === "Library" ||
              (specifier.type === "ImportNamespaceSpecifier" &&
                target !== "packages/skit/src/index")
            )
              libraryNamespaces.add(specifier.local.name);
            else if (specifier.type === "ImportNamespaceSpecifier")
              coreNamespaces.add(specifier.local.name);
          }
        if (inside && !(publicEntry && exporting)) return;
        const storage = storageModule(target);
        const whole =
          node.type === "ExportAllDeclaration" ||
          node.type === "ImportExpression" ||
          node.specifiers?.some(
            (specifier) =>
              specifier.type === "ImportNamespaceSpecifier" ||
              specifier.type === "ExportNamespaceSpecifier",
          );
        const selfNamespace = file === `${library}library.ts` && target === `${library}library`;
        if (
          storage ||
          (whole &&
            (privateExportModules.has(target) ||
              target.startsWith(`${library}internal/`) ||
              (exporting && publicSource && !selfNamespace)))
        ) {
          context.report({ node, messageId: "wildcard", data: { name: node.source.value } });
          return;
        }
        for (const specifier of node.specifiers ?? []) {
          if (typeOnly(node, specifier)) continue;
          const name = nameOf(specifier.imported ?? specifier.local);
          if (
            privateNames.has(name) ||
            (name === "make" && publicSource && target !== "packages/skit/src/index")
          )
            context.report({ node: specifier, messageId: "private", data: { name } });
        }
      };
      return {
        ...declarations(check),
        ExportNamedDeclaration(node) {
          check(node, true);
          if (
            file === `${library}library.ts` &&
            (node.specifiers.some((specifier) => nameOf(specifier.local) === "make") ||
              node.declaration?.id?.name === "make" ||
              node.declaration?.declarations?.some((entry) => entry.id.name === "make"))
          )
            context.report({ node, messageId: "constructor" });
        },
        MemberExpression(node) {
          if (inside) return;
          const name = nameOf(node.property);
          const fromCore = coreNamespaces.has(node.object?.name);
          const fromLibrary =
            libraryNamespaces.has(node.object?.name) ||
            (node.object?.type === "MemberExpression" &&
              coreNamespaces.has(node.object.object?.name) &&
              nameOf(node.object.property) === "Library");
          if (fromLibrary && name === "make") context.report({ node, messageId: "constructor" });
          else if (fromCore && privateNames.has(name))
            context.report({ node, messageId: "private", data: { name } });
          const constructing =
            isInstalledNamespace(node.object) && ["make", "layer"].includes(name);
          const changing =
            installedInstance(node.object) &&
            ["prepare", "install", "manage", "backUp", "uninstall"].includes(name);
          const changingBackup =
            node.object?.type === "MemberExpression" &&
            installedInstance(node.object.object) &&
            nameOf(node.object.property) === "backups" &&
            ["keep", "discard"].includes(name);
          if (constructing || changing || changingBackup)
            context.report({ node, messageId: "installed", data: { name } });
        },
        VariableDeclarator(node) {
          if (!inside && node.id.type === "Identifier" && installedService(node.init))
            installedInstances.add(node.id.name);
          if (inside || node.id.type !== "ObjectPattern") return;
          const fromCore = coreNamespaces.has(node.init?.name);
          const fromLibrary = libraryNamespaces.has(node.init?.name);
          for (const property of node.id.properties) {
            const name = nameOf(property.key);
            if (fromLibrary && name === "make")
              context.report({ node: property, messageId: "constructor" });
            else if (fromCore && privateNames.has(name))
              context.report({ node: property, messageId: "private", data: { name } });
            if (
              (isInstalledNamespace(node.init) && ["make", "layer"].includes(name)) ||
              (installedInstance(node.init) &&
                ["prepare", "install", "manage", "backUp", "uninstall"].includes(name))
            )
              context.report({ node: property, messageId: "installed", data: { name } });
          }
        },
      };
    },
  },

  "library-recorded-execution": {
    meta: {
      type: "problem",
      docs: {
        description: "Folder execution and history delivery use the recorded operation boundary",
      },
      messages: {
        forbidden:
          "{{name}} executes Library work outside its recorded-operation boundary. Allowed execution callers: {{callers}}. A lock or exit callback is not a durable operation record.",
      },
    },
    create(context) {
      const file = relative(root, context.filename);
      if (!file.startsWith("packages/") || !file.includes("/src/")) return {};
      return declarations((node, exporting) => {
        if (typeOnly(node)) return;
        const target = targetOf(context.filename, node.source?.value);
        const edge = executionEdges.find((entry) => entry.module === target);
        if (!edge || (!exporting && edge.callers.includes(file))) return;
        const whole =
          node.type === "ImportExpression" ||
          node.type === "ExportAllDeclaration" ||
          node.specifiers?.some(
            (specifier) =>
              specifier.type === "ImportNamespaceSpecifier" ||
              specifier.type === "ExportNamespaceSpecifier",
          );
        const report = (at, name) =>
          context.report({
            node: at,
            messageId: "forbidden",
            data: { name, callers: edge.callers.join(", ") },
          });
        if (whole) report(node, node.source.value);
        else
          for (const specifier of node.specifiers ?? []) {
            const name = nameOf(specifier.imported ?? specifier.local);
            if (!typeOnly(node, specifier) && edge.names.includes(name)) report(specifier, name);
          }
      });
    },
  },
};
