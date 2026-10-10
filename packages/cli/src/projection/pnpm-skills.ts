import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Cache, Data, Duration, Effect, Exit, FileSystem, Option, Schema } from "effect";
import { LinkStat, pathIsWithin } from "@smolai/skit-core";
import { parseDocument } from "yaml";

export const PnpmSkillOwner = Schema.Struct({
  kind: Schema.tag("pnpm"),
  package: Schema.String,
  version: Schema.String,
  ledgerPath: Schema.String,
});

const PnpmPackage = Schema.Struct({ name: Schema.NonEmptyString, version: Schema.NonEmptyString });
// Invalid individual entries are skipped below; they must not hide valid neighboring entries.
const PnpmLedger = Schema.Struct({
  packageManager: Schema.String,
  linkedSkills: Schema.Array(Schema.Unknown),
});

type PnpmDocument = Data.TaggedEnum<{
  Missing: {};
  Malformed: {};
  Unreadable: {};
  Parsed: { readonly value: unknown };
}>;
const PnpmDocument = Data.taggedEnum<PnpmDocument>();

const documentAt = Effect.fn("PnpmSkills.document")(function* (
  path: string,
): Effect.fn.Return<PnpmDocument, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* Effect.result(fs.readFileString(path));
  if (result._tag === "Failure") {
    if (result.failure.reason._tag === "NotFound") return PnpmDocument.Missing();
    yield* Effect.logDebug("Cannot read pnpm Skill evidence", {
      path,
      reason: result.failure.reason._tag,
    });
    return PnpmDocument.Unreadable();
  }
  try {
    const document = parseDocument(result.success);
    if (document.errors.length) return PnpmDocument.Malformed();
    const value: unknown = document.toJSON();
    return PnpmDocument.Parsed({ value });
  } catch {
    return PnpmDocument.Malformed();
  }
});

/** Corroborate pnpm's ledger with a live link into an installed package's skills directory.
 * A prefix alone, stale ledger entry, or ordinary copy never establishes pnpm management.
 */
const observePnpmSkill = Effect.fn("PnpmSkills.observe")(function* (
  directory: string,
  readDocument: (path: string) => Effect.Effect<PnpmDocument>,
) {
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
  const packageDocument = yield* readDocument(join(packageRoot, "package.json"));
  if (packageDocument._tag !== "Parsed") return undefined;
  const pkg = Schema.decodeUnknownOption(PnpmPackage)(packageDocument.value);
  if (Option.isNone(pkg)) return undefined;
  const { name: packageName, version } = pkg.value;

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
    const ledgerDocument = yield* readDocument(ledgerPath);
    if (ledgerDocument._tag !== "Parsed") continue;
    const ledger = Schema.decodeUnknownOption(PnpmLedger)(ledgerDocument.value);
    if (Option.isSome(ledger) && ledger.value.packageManager.startsWith("pnpm@")) {
      const workspace = dirname(modulesDir);
      for (const entry of ledger.value.linkedSkills) {
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

export type PnpmSkillObserver = (directory: string) => ReturnType<typeof observePnpmSkill>;

/** One cache per read-only scan. Never share this observer across review and apply. */
export const makePnpmSkillObserver = Effect.fn("PnpmSkills.makeObserver")(function* () {
  const documents = yield* Cache.makeWith(documentAt, {
    capacity: 512,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value._tag !== "Unreadable" ? Duration.infinity : Duration.zero,
  });
  const readDocument = (path: string) => Cache.get(documents, resolve(path));
  return (directory: string) => observePnpmSkill(directory, readDocument);
});

/** Standalone and mutation-time checks always start with fresh evidence. */
export const pnpmSkillOwner = Effect.fn("PnpmSkills.owner")(function* (directory: string) {
  const observe = yield* makePnpmSkillObserver();
  return yield* observe(directory);
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
