import { build } from "esbuild";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const jsoncParserEsm = fileURLToPath(import.meta.resolve("jsonc-parser/lib/esm/main.js"));
const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));

const result = await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/src/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  alias: {
    "jsonc-parser": jsoncParserEsm,
  },
  define: {
    __SKIT_VERSION__: JSON.stringify(packageMetadata.version),
  },
  legalComments: "external",
  metafile: true,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});

const builtins = new Set(
  builtinModules.flatMap((name) => [name, name.startsWith("node:") ? name : `node:${name}`]),
);
const externalImports = Object.values(result.metafile.outputs).flatMap((output) =>
  output.imports.filter(({ external }) => external).map(({ path }) => path),
);
const packageImports = externalImports.filter(
  (path) => !path.startsWith("node:") && !builtins.has(path),
);
if (packageImports.length > 0) {
  throw new Error(
    `CLI bundle retained package imports: ${[...new Set(packageImports)].join(", ")}`,
  );
}
