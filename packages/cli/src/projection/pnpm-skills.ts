import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { isJsonObject, LinkStat, pathIsWithin, stringAt } from "@smolai/skit-core";
import { parseDocument } from "yaml";

export const PnpmSkillOwner = Schema.Struct({
  kind: Schema.tag("pnpm"),
  package: Schema.String,
  version: Schema.String,
  ledgerPath: Schema.String,
});

const documentAt = Effect.fn("PnpmSkills.document")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => undefined));
  if (text === undefined) return undefined;
  try {
    const document = parseDocument(text);
    if (document.errors.length) return undefined;
    const value: unknown = document.toJSON();
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
});

/** Corroborate pnpm's ledger with a live link into an installed package's skills directory.
 * A prefix alone, stale ledger entry, or ordinary copy never establishes pnpm management.
 */
export const pnpmSkillOwner = Effect.fn("PnpmSkills.owner")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const caller = resolve(directory);
  const callerParent = yield* fs
    .realPath(dirname(caller))
    .pipe(Effect.orElseSucceed(() => dirname(caller)));
  const callerPath = join(callerParent, basename(caller));
  const canonical = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined));
  if (canonical === undefined || basename(dirname(canonical)) !== "skills") return undefined;
  const packageRoot = dirname(dirname(canonical));
  const pkg = yield* documentAt(join(packageRoot, "package.json"));
  const packageName = pkg && stringAt(pkg, "name");
  const version = pkg && stringAt(pkg, "version");
  if (!packageName || !version) return undefined;

  // Target ancestry finds custom modules directories; alias ancestry finds linked local packages.
  const candidates = new Set<string>();
  for (const start of [dirname(packageRoot), resolve(directory)]) {
    for (let ancestor = start; ; ancestor = dirname(ancestor)) {
      candidates.add(ancestor);
      candidates.add(join(ancestor, "node_modules"));
      if (ancestor === dirname(ancestor)) break;
    }
  }
  for (const modulesDir of candidates) {
    const ledgerPath = join(modulesDir, ".modules.yaml");
    const ledger = yield* documentAt(ledgerPath);
    const manager = ledger && stringAt(ledger, "packageManager");
    const recorded = ledger?.linkedSkills;
    if (manager?.startsWith("pnpm@") && Array.isArray(recorded)) {
      const workspace = dirname(modulesDir);
      for (const entry of recorded) {
        if (typeof entry !== "string" || isAbsolute(entry)) continue;
        if (entry.split(/[\\/]/).includes("..")) continue;
        const path = resolve(workspace, entry);
        if (!pathIsWithin(workspace, path) || !basename(path).startsWith("pnpm-")) continue;
        if (!basename(path).endsWith(`-${basename(canonical)}`)) continue;
        const info = yield* links.lstat(path).pipe(Effect.orElseSucceed(() => undefined));
        if (info?.type !== "SymbolicLink") continue;
        const target = yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => undefined));
        if (target !== canonical) continue;
        const physicalModules = yield* fs
          .realPath(modulesDir)
          .pipe(Effect.orElseSucceed(() => modulesDir));
        const recordedParent = yield* fs
          .realPath(dirname(path))
          .pipe(Effect.orElseSucceed(() => dirname(path)));
        const recordedPath = join(recordedParent, basename(path));
        // pnpm owns its recorded entry and installed package views, not an author's source
        // or an unrelated user-created alias that happens to point at the same directory.
        if (
          callerPath !== recordedPath &&
          !pathIsWithin(physicalModules, callerPath) &&
          !pathIsWithin(modulesDir, caller)
        )
          continue;
        if (!pathIsWithin(physicalModules, canonical)) {
          const segment = basename(path).slice(5, -`-${basename(canonical)}`.length);
          const alias = segment.startsWith("@") ? segment.replace("+", "/") : segment;
          if (alias.split(/[\\/]/).some((part) => part === ".." || part === ".")) continue;
          const dependency = yield* fs
            .realPath(join(modulesDir, alias))
            .pipe(Effect.orElseSucceed(() => undefined));
          if (dependency !== packageRoot) continue;
        }
        return { kind: "pnpm" as const, package: packageName, version, ledgerPath };
      }
    }
  }
  return undefined;
});

export class PnpmSkillManaged extends Schema.TaggedError<PnpmSkillManaged>()("PnpmSkillManaged", {
  path: Schema.String,
  package: Schema.String,
}) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Manage this Skill through pnpm's dependency and permission settings.";
  get message() {
    return `${this.path} is managed by pnpm (${this.package}); SKIT leaves it in place.`;
  }
}

export const leavePnpmSkillEffect = Effect.fn("PnpmSkills.leaveManaged")(function* (path: string) {
  const owner = yield* pnpmSkillOwner(path);
  if (owner) return yield* new PnpmSkillManaged({ path, package: owner.package });
});
