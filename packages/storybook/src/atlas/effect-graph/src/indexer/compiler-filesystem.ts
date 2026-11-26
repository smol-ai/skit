import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { serverFS, type FileSystemCallbacks } from "tsrs/fs";
import { CompilerEnvironment, CompilerObservation } from "./compiler-environment.ts";
import * as Schema from "effect/Schema";

type Operation = typeof CompilerObservation.Type.operation;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const file = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } };
const stat = (path: string) => { try { return statSync(path); } catch { return undefined; } };
const entries = (path: string) => {
  const files: string[] = [], directories: string[] = [], symlinks: string[] = [];
  if (stat(path)?.isDirectory()) for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) symlinks.push(entry.name);
    const directory = entry.isDirectory() || entry.isSymbolicLink() && stat(resolve(path, entry.name))?.isDirectory();
    (directory ? directories : files).push(entry.name);
  }
  return { files: files.sort(), directories: directories.sort(), symlinks: symlinks.sort() };
};
const inspect = (operation: Operation, path: string) => {
  switch (operation) {
    case "readFile": return file(path);
    case "fileExists": return stat(path)?.isFile() ?? false;
    case "directoryExists": return stat(path)?.isDirectory() ?? false;
    case "entries": return entries(path);
    case "realpath": { try { return realpathSync(path); } catch { return path; } }
  }
};

/** Revalidate both content and resolution probes, including previously absent paths. */
export function compilerEnvironmentIssue(value: unknown): string | undefined {
  const parsed = Schema.decodeUnknownOption(CompilerEnvironment)(value);
  if (parsed._tag === "None") return "compiler environment provenance is missing or invalid";
  for (const observation of parsed.value.observations)
    if (digest(inspect(observation.operation, observation.path)) !== observation.digest)
      return `compiler input changed: ${observation.operation} ${observation.path}`;
  return undefined;
}

/** Snapshot files/configs are immutable; installed packages and external inputs
 * are observed through the compiler's actual filesystem callbacks. */
export function compilerFileSystem(repo: string, sources: ReadonlyArray<{ readonly path: string; readonly text: string }>, pinned: boolean) {
  const bodies = new Map(sources.map((source) => [resolve(repo, source.path), source.text]));
  const directories = new Map<string, { files: Set<string>; directories: Set<string> }>();
  const directory = (path: string) => {
    let found = directories.get(path);
    if (!found) { found = { files: new Set(), directories: new Set() }; directories.set(path, found); }
    return found;
  };
  for (const path of bodies.keys()) {
    directory(dirname(path)).files.add(basename(path));
    for (let at = dirname(path); at !== repo && at.startsWith(`${repo}/`); at = dirname(at))
      directory(dirname(at)).directories.add(basename(at));
  }
  const inSnapshot = (path: string) => pinned && (path === repo || path.startsWith(`${repo}/`))
    && !relative(repo, path).split("/").includes("node_modules");
  // A workspace package is linked into node_modules (`node_modules/@app/infra -> ../../packages/infra`):
  // it is the repository's own source, so it is read at the pin under the path the link points to.
  const links = new Map<string, string>();
  // The repository as the filesystem resolves it, when its own path passes through a link.
  let realRepo = repo; try { realRepo = realpathSync(repo); } catch {}
  const linked = (path: string): string | undefined => {
    if (!pinned || !path.startsWith(`${repo}/`)) return undefined;
    const parts = relative(repo, path).split("/");
    const modules = parts.lastIndexOf("node_modules");
    if (modules < 0) return undefined;
    // The package directory: `node_modules/name` or `node_modules/@scope/name`.
    const end = modules + (parts[modules + 1]?.startsWith("@") ? 3 : 2);
    if (parts.length < end) return undefined;
    const link = resolve(repo, ...parts.slice(0, end));
    let target = links.get(link);
    if (target === undefined) {
      let isLink = false; try { isLink = lstatSync(link).isSymbolicLink(); } catch {}
      // An installed package is read from disk as before; only a link is followed.
      if (isLink) { try { target = realpathSync(link); } catch { target = ""; } observed("realpath", link, target); }
      else target = "";
      if (target === realRepo || target.startsWith(`${realRepo}/`)) target = resolve(repo, relative(realRepo, target));
      links.set(link, target);
    }
    return target && inSnapshot(target) ? resolve(target, ...parts.slice(end)) : undefined;
  };
  const pinnedPath = (path: string) => inSnapshot(path) ? path : linked(path);
  // Resolution walks up to ancestor node_modules; those belong to whatever contains a pinned
  // checkout (this tool's own install), not to the pinned repository, so they do not exist.
  const ancestorModules: string[] = [];
  for (let at = dirname(repo); ; at = dirname(at)) { ancestorModules.push(resolve(at, "node_modules")); if (at === dirname(at)) break; }
  const outside = (path: string) => pinned && ancestorModules.some((modules) => path === modules || path.startsWith(`${modules}/`));
  const observations = new Map<string, typeof CompilerObservation.Type>();
  const observed = (operation: Operation, path: string, value: unknown) => {
    const hash = digest(value), key = `${operation}\0${path}`;
    const before = observations.get(key);
    if (before && before.digest !== hash) throw new Error(`Compiler input changed during extraction: ${path}`);
    observations.set(key, { operation, path, digest: hash });
    return value;
  };
  const readFile = (path: string) => {
    const at = pinnedPath(path);
    if (at !== undefined) return bodies.get(at);
    if (outside(path)) return undefined;
    const value = file(path); observed("readFile", path, value); return value;
  };
  const fileExists = (path: string) => {
    const at = pinnedPath(path);
    if (at !== undefined) return bodies.has(at);
    if (outside(path)) return false;
    const value = stat(path)?.isFile() ?? false; observed("fileExists", path, value); return value;
  };
  const directoryExists = (path: string) => {
    const at = pinnedPath(path);
    if (at !== undefined) return directories.has(at);
    if (outside(path)) return false;
    const value = stat(path)?.isDirectory() ?? false; observed("directoryExists", path, value); return value;
  };
  // Keep callback result types explicit: each operation has one filesystem shape.
  const callbacks: FileSystemCallbacks = {
    readFile, fileExists, directoryExists,
    getAccessibleEntries: (path) => {
      if (outside(path)) return { files: [], directories: [], symlinks: [] };
      const at = pinnedPath(path);
      if (at === undefined) { const value = entries(path); observed("entries", path, value); return value; }
      const found = directories.get(at);
      const children = [...(found?.directories ?? [])];
      const dependencies = resolve(at, "node_modules");
      const installed = stat(dependencies)?.isDirectory() ?? false;
      observed("directoryExists", dependencies, installed);
      if (installed) children.push("node_modules");
      return { files: [...(found?.files ?? [])].sort(), directories: children.sort(), symlinks: [] };
    },
    realpath: (path) => {
      const at = pinnedPath(path);
      if (at !== undefined) return at;
      let value: string = path; try { value = realpathSync(path); } catch {}
      observed("realpath", path, value); return value;
    },
    stat: serverFS.fakeStat,
    writeFile: serverFS.error,
    removeFile: serverFS.error,
  };
  return {
    callbacks,
    readFile,
    exists: (path: string) => fileExists(path) || directoryExists(path),
    environment: (): CompilerEnvironment => ({ format: "compiler-environment-v1", observations: [...observations.values()]
      .sort((a, b) => `${a.operation}\0${a.path}`.localeCompare(`${b.operation}\0${b.path}`)) }),
  };
}
