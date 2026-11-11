import { buildInfo } from "../../../scripts/build-info.mjs";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { copyFile, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const jsoncParserEsm = fileURLToPath(import.meta.resolve("jsonc-parser/lib/esm/main.js"));
const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));

const outputs = [
  { entry: "src/main.ts", file: "dist/src/main.js", external: [] },
  // The optional story API shares its consumer's Effect runtime; the CLI binary is standalone.
  {
    entry: "src/storybook/index.ts",
    file: "dist/src/storybook/index.js",
    external: ["effect", "effect/*"],
    splitting: true,
  },
];
// Preserve the lazy Node-only author journal adapter when Storybook runs under Bun.
// A single bundled file would hoist its node:sqlite import into the public entry point.
await rm("dist/src/storybook/chunks", { recursive: true, force: true });
const results = await Promise.all(
  outputs.map(async (output) => ({
    output,
    result: await build({
      entryPoints: [output.entry],
      ...(output.splitting
        ? {
            outdir: "dist/src/storybook",
            entryNames: "index",
            chunkNames: "chunks/[name]-[hash]",
            splitting: true,
          }
        : { outfile: output.file }),
      external: output.external,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      alias: {
        "jsonc-parser": jsoncParserEsm,
      },
      define: {
        __SKIT_BUILD__: JSON.stringify(buildInfo(packageMetadata)),
      },
      legalComments: "external",
      metafile: true,
      banner: {
        js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
      },
    }),
  })),
);

const builtins = new Set(
  builtinModules.flatMap((name) => [name, name.startsWith("node:") ? name : `node:${name}`]),
);
for (const { output, result } of results) {
  const externalImports = Object.values(result.metafile.outputs).flatMap((output) =>
    output.imports.filter(({ external }) => external).map(({ path }) => path),
  );
  // ws (reached through Effect's Node HTTP client) loads these native speed-ups inside try/catch
  // and falls back without them, so leaving them unresolved is safe.
  const optionalAddons = new Set(["bufferutil", "utf-8-validate"]);
  const packageImports = externalImports.filter(
    (path) =>
      !path.startsWith("node:") &&
      !builtins.has(path) &&
      !optionalAddons.has(path) &&
      !(output.external.length > 0 && (path === "effect" || path.startsWith("effect/"))),
  );
  if (packageImports.length > 0) {
    throw new Error(
      `Bundle ${output.file} retained undeclared package imports: ${[...new Set(packageImports)].join(", ")}`,
    );
  }
}

// Storybook embeds the pinned upstream document fixture; retain its license in the package.
await copyFile(
  "src/storybook/fixtures/doctor-collection.LICENSE",
  "dist/src/storybook/chunks/doctor-collection.LICENSE",
);
