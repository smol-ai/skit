import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { features } from "../architecture/layout.mjs";

const root = resolve(import.meta.dirname, "..");
const coreExports = JSON.parse(
  readFileSync(resolve(root, "packages/skit/package.json"), "utf8"),
).exports;

export const structureRules = {
  "feature-entry": {
    meta: {
      type: "problem",
      docs: {
        description:
          "Declared features have one public sibling module and unprefixed private files",
      },
      messages: {
        sibling:
          "{{file}} belongs inside {{feature}}/. The feature name appears only as {{feature}}.ts and {{feature}}/.",
        prefix:
          "{{file}} repeats the feature name {{name}}. Files inside {{feature}}/ must not repeat {{name}}-.",
        private: "{{target}} is private to {{feature}}/. Import {{feature}}.ts instead.",
      },
    },
    create(context) {
      const file = relative(root, context.filename);
      const check = (node) => {
        const source = node.source?.value;
        if (typeof source !== "string") return;
        let target;
        if (source.startsWith(".")) {
          target = relative(root, resolve(dirname(context.filename), source)).replace(
            /\.js$/,
            ".ts",
          );
        } else if (source.startsWith("@smolai/skit-core/")) {
          const subpath = `./${source.slice("@smolai/skit-core/".length)}`;
          const entry = coreExports[subpath]?.import;
          target = entry
            ? `packages/skit/${entry.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")}`
            : `packages/skit/src/${subpath.slice(2)}`;
        }
        if (!target) return;
        for (const feature of features) {
          if (!target.startsWith(`${feature}/`)) continue;
          const packageTests = `${feature.split("/src/")[0]}/test/`;
          if (
            file.startsWith(`${feature}/`) ||
            file === `${feature}.ts` ||
            file.startsWith(packageTests)
          )
            continue;
          context.report({ node: node.source, messageId: "private", data: { target, feature } });
        }
      };
      return {
        Program(node) {
          for (const feature of features) {
            if (file.startsWith(`${feature}-`))
              context.report({ node, messageId: "sibling", data: { file, feature } });
            if (!file.startsWith(`${feature}/`)) continue;
            const name = feature.split("/").at(-1);
            if (
              file
                .slice(feature.length + 1)
                .split("/")
                .some((part) => part.startsWith(`${name}-`))
            )
              context.report({ node, messageId: "prefix", data: { file, name, feature } });
          }
        },
        ImportDeclaration: check,
        ExportNamedDeclaration: check,
        ExportAllDeclaration: check,
        ImportExpression: check,
      };
    },
  },
};
