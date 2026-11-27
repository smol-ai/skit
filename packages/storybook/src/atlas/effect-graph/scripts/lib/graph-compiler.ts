import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const defaultGraphCompiler = dirname(require.resolve("tsrs/package.json"));
export interface GraphCompilerVersions { readonly typescript: string; readonly tsrs: string; readonly typescriptCommit: string; readonly fingerprint: string }
export const graphCompilerExecutable = (): string => require(resolve(defaultGraphCompiler, "lib/getExePath.js")).default();
export const graphCompilerVersions = (): GraphCompilerVersions => {
  const pkg = JSON.parse(readFileSync(resolve(defaultGraphCompiler, "package.json"), "utf8"));
  if (pkg.version !== "0.20.0-ts7.1.0-beta") throw new Error(`Unexpected tsrs version ${pkg.version}`);
  const hash = createHash("sha256").update(JSON.stringify(pkg)).update(readFileSync(graphCompilerExecutable()));
  const visit = (directory: string): void => {
    for (const entry of readdirSync(resolve(defaultGraphCompiler, directory), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:[cm]?js|json)$/.test(entry.name)) hash.update(path).update(readFileSync(resolve(defaultGraphCompiler, path)));
    }
  };
  for (const directory of ["bin", "lib", "dist"]) visit(directory);
  return { typescript: pkg.tsrs.typescriptVersion, tsrs: pkg.version, typescriptCommit: pkg.tsrs.typescriptCommit, fingerprint: hash.digest("hex") };
};
