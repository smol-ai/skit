import { dirname, relative, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { owners } from "../architecture/boundaries.mjs";

const root = resolve(import.meta.dirname, "..");
const library = "packages/skit/src/library/";
// Follow the published entry points so adding a subpath cannot reopen raw filesystem writes.
const coreManifest = JSON.parse(readFileSync(resolve(root, "packages/skit/package.json"), "utf8"));
const publicCoreEntries = new Set(
  Object.values(coreManifest.exports).map(
    (entry) =>
      `packages/skit/${entry.import.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")}`,
  ),
);

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
    callers: [],
  },
  {
    module: `${library}internal/operations/apply`,
    names: ["apply", "settleBackups"],
    callers: [`${library}internal/operations/operations.ts`],
  },
  {
    module: `${library}internal/operations/installed-changes`,
    names: ["execute"],
    callers: [`${library}internal/operations/apply.ts`],
  },
  {
    module: `${library}internal/operations/recorded`,
    names: ["saveStep"],
    callers: [
      `${library}internal/operations/operations.ts`,
      `${library}internal/operations/apply.ts`,
    ],
  },
  {
    module: `${library}installed-update`,
    names: ["updateInstalledSkills"],
    callers: [`${library}internal/setup/steps.ts`],
  },
  {
    module: `${library}internal/setup/steps`,
    names: ["runManage", "runUpdate"],
    callers: [`${library}internal/setup/run.ts`],
  },
  {
    module: `${library}internal/setup/moves`,
    names: ["moveAside"],
    callers: [
      `${library}internal/setup/run.ts`,
      `${library}internal/setup/steps.ts`,
      `${library}internal/setup/undo-execution.ts`,
    ],
  },
  {
    module: `${library}internal/setup/undo-files`,
    names: ["prepareSetupUndoFiles"],
    callers: [`${library}internal/setup/run.ts`],
  },
  {
    module: `${library}internal/setup/undo-files`,
    names: ["restoreMarker"],
    callers: [`${library}internal/setup/undo-execution.ts`],
  },
  {
    module: `${library}internal/setup/undo-execution`,
    names: ["runUndo"],
    callers: [`${library}internal/setup/run.ts`],
  },
  {
    module: `${library}internal/recovery/moves`,
    names: ["prepareRecoveryRestore", "restoreRecorded"],
    callers: [`${library}internal/setup/run.ts`],
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
  "library-apply-program": {
    meta: {
      type: "problem",
      docs: { description: "Recorded execution cannot accept or reconstruct a Plan" },
      messages: {
        plan: "Recorded execution consumes InstalledApply. Planning and review belong before recording; no Plan, planner or review imports are allowed here.",
        field:
          "{{name}} duplicates the recorded installed changes. Keep legacy Apply fields in the v12 migration codec only.",
      },
    },
    create(context) {
      const file = relative(root, context.filename);
      const executor = [
        "internal/operations/apply.ts",
        "internal/operations/installed-changes.ts",
      ].some((path) => file === library + path);
      const schema = file === library + "store/state-schema.ts";
      const banned = new Set(["Plan", "planIntent", "planChanges", "reviewApply", "prepareApply"]);
      return {
        ...declarations((node) => {
          if (!executor) return;
          const target = targetOf(context.filename, node.source?.value);
          if (
            ![
              "library-plan",
              "plan-changes",
              "internal/operations/review",
              "internal/operations/recorded",
            ].some((path) => target === library + path)
          )
            return;
          const whole =
            node.type === "ImportExpression" ||
            node.type === "ExportAllDeclaration" ||
            node.specifiers?.some((specifier) =>
              ["ImportNamespaceSpecifier", "ExportNamespaceSpecifier"].includes(specifier.type),
            );
          if (
            whole ||
            node.specifiers?.some((specifier) =>
              banned.has(nameOf(specifier.imported ?? specifier.local)),
            )
          )
            context.report({ node, messageId: "plan" });
        }),
        VariableDeclarator(node) {
          if (!schema || !["installedApply", "InstalledApply"].includes(node.id.name)) return;
          const fields = node.init?.arguments?.[1];
          for (const property of fields?.properties ?? []) {
            const name = nameOf(property.key);
            if (
              ["reviewed", "ids", "expected", "installedAt", "prepared", "completed"].includes(name)
            )
              context.report({ node: property, messageId: "field", data: { name } });
          }
        },
      };
    },
  },

  "library-operation-owner": {
    meta: {
      type: "problem",
      docs: {
        description: "Installed-change adapters and filesystem execution cannot own Library writes",
      },
      messages: {
        owner:
          "{{name}} belongs to the Library operation owner. Adapters request recorded changes; filesystem execution cannot save state or journal progress.",
        legacy:
          "The legacy apply executor must be removed. Use the Library operation owner for recorded installed changes.",
      },
    },
    create(context) {
      const file = relative(root, context.filename);
      if (!file.startsWith(library) || !file.endsWith(".ts")) return {};
      const adapter = [
        "internal/setup/steps.ts",
        "installed-update.ts",
        "internal/sync/operation.ts",
      ].some((path) => file === library + path);
      const executor = file === library + "internal/operations/installed-changes.ts";
      const installed = new Set();
      const routing = new Set();
      const instances = new Set();
      const mutators = new Set(["prepare", "build", "install", "manage", "backUp", "uninstall"]);
      const check = declarations((node) => {
        if (typeOnly(node)) return;
        const target = targetOf(context.filename, node.source?.value);
        if (adapter && node.type === "ImportDeclaration")
          for (const specifier of node.specifiers) {
            if (typeOnly(node, specifier)) continue;
            if (
              target === library + "installed-skills" &&
              nameOf(specifier.imported) === "InstalledSkills"
            )
              installed.add(specifier.local.name);
            if (
              target === library + "routing/recorded" &&
              nameOf(specifier.imported) === "routedInstalledSkills"
            )
              routing.add(specifier.local.name);
          }
        if (target === library + "apply-plan") {
          context.report({ node, messageId: "legacy" });
          return;
        }
        if (!adapter && !executor) return;
        const names =
          target === library + "store/library-store"
            ? executor
              ? null
              : ["LibraryWriter", "writeLibrary"]
            : target === library + "store/state-file" || target === library + "store/writer-lock"
              ? null
              : undefined;
        if (names === undefined) return;
        if (
          names === null ||
          node.type === "ImportExpression" ||
          node.type === "ExportAllDeclaration"
        ) {
          context.report({ node, messageId: "owner", data: { name: node.source.value } });
          return;
        }
        if (privateNames.has(nameOf(node.exported)))
          context.report({ node, messageId: "private", data: { name: nameOf(node.exported) } });
        for (const specifier of node.specifiers ?? []) {
          if (typeOnly(node, specifier)) continue;
          const name = nameOf(specifier.imported ?? specifier.local ?? specifier.exported);
          if (
            specifier.type === "ImportNamespaceSpecifier" ||
            specifier.type === "ExportNamespaceSpecifier" ||
            names.includes(name)
          )
            context.report({
              node: specifier,
              messageId: "owner",
              data: { name: name ?? node.source.value },
            });
        }
      });
      const isInstance = (node) =>
        instances.has(node?.name) ||
        (node?.type === "YieldExpression" &&
          node.argument?.type === "MemberExpression" &&
          installed.has(node.argument.object?.name) &&
          nameOf(node.argument.property) === "Service");
      const forbiddenMember = (object, name) =>
        (isInstance(object) && mutators.has(name)) ||
        (object?.type === "MemberExpression" &&
          isInstance(object.object) &&
          nameOf(object.property) === "backups" &&
          ["keep", "discard"].includes(name));
      return {
        ...check,
        VariableDeclarator(node) {
          if (!adapter) return;
          if (
            node.id.type === "Identifier" &&
            (isInstance(node.init) ||
              (node.init?.type === "YieldExpression" &&
                node.init.argument?.type === "CallExpression" &&
                routing.has(node.init.argument.callee?.name)))
          )
            instances.add(node.id.name);
          if (node.id.type === "ObjectPattern")
            for (const property of node.id.properties)
              if (forbiddenMember(node.init, nameOf(property.key)))
                context.report({
                  node: property,
                  messageId: "owner",
                  data: { name: nameOf(property.key) },
                });
        },
        MemberExpression(node) {
          if (adapter && forbiddenMember(node.object, nameOf(node.property)))
            context.report({ node, messageId: "owner", data: { name: nameOf(node.property) } });
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
      if (!file.startsWith("packages/")) return {};
      const inside = file.startsWith(library);
      const rawConstructor = (node) => {
        if (
          !inside &&
          targetOf(context.filename, node.source?.value) === `${library}internal/runtime`
        ) {
          context.report({ node, messageId: "constructor" });
          return true;
        }
        return false;
      };
      if (!file.includes("/src/")) return declarations(rawConstructor);
      const publicEntry =
        file === `${library}library.ts` ||
        file === `${library}index.ts` ||
        publicCoreEntries.has(file);
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
        if (rawConstructor(node)) return;
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
        if (
          storage ||
          (whole &&
            (privateExportModules.has(target) ||
              (publicCoreEntries.has(file) &&
                exporting &&
                [
                  "packages/skit/src/platform/atomic-write",
                  "packages/skit/src/platform/copy-tree",
                  "packages/skit/src/installed-skills/writable",
                ].includes(target)) ||
              target.startsWith(`${library}internal/`) ||
              (exporting && publicSource)))
        ) {
          context.report({ node, messageId: "wildcard", data: { name: node.source.value } });
          return;
        }
        if (privateNames.has(nameOf(node.exported)))
          context.report({ node, messageId: "private", data: { name: nameOf(node.exported) } });
        for (const specifier of node.specifiers ?? []) {
          if (typeOnly(node, specifier)) continue;
          const name = nameOf(specifier.imported ?? specifier.local ?? specifier.exported);
          if (
            publicCoreEntries.has(file) &&
            exporting &&
            [
              "writeRawAtomic",
              "writeJsonAtomic",
              "writeJsonExclusive",
              "copyLocalTree",
              "copySkill",
              "ensureSkillsDirectoryWritable",
            ].includes(name)
          ) {
            context.report({ node: specifier, messageId: "private", data: { name } });
            continue;
          }
          if (privateNames.has(name) || (name === "make" && publicSource))
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
            const name = nameOf(specifier.imported ?? specifier.local ?? specifier.exported);
            if (!typeOnly(node, specifier) && edge.names.includes(name)) report(specifier, name);
          }
      });
    },
  },
};
