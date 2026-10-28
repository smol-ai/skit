import type { PlatformError } from "effect/PlatformError";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { Data, Effect, FileSystem, Schema } from "effect";
import {
  HarnessName,
  LinkStat,
  harnessDrivers,
  parseSkillFrontmatter,
  resolveSkillsDirectory,
  type SkitBindingScope,
} from "@smolai/skit-core";
import { activeInstallDestinations, bindingRoot, type InventoryRootOptions } from "./roots.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";

export const SkillAlias = Schema.Struct({
  path: Schema.String,
  via: Schema.Literals(["symlink", "directory", "unknown-root"]),
  linkPath: Schema.optionalKey(Schema.String),
  linkTarget: Schema.optionalKey(Schema.String),
});

/**
 * Whether this entry is itself a symlink. A path reached through a linked parent (macOS `/var` is
 * a link to `/private/var`) is also reported `via: "symlink"`, but the skill entry there is an
 * ordinary directory and replacing it removes no link.
 */
export const isEntryLink = (alias: SkillAlias): boolean =>
  alias.via === "symlink" && alias.linkPath === alias.path;
export type SkillAlias = typeof SkillAlias.Type;
export const DuplicateCopy = Schema.Struct({
  name: Schema.String,
  harness: Schema.String,
  canonicalPath: Schema.String,
  aliases: Schema.Array(SkillAlias),
  documentDigest: Schema.String,
});
export type DuplicateCopy = typeof DuplicateCopy.Type;
/** Each Harness's readable skills directories for a scope; a global override stands in for its own. */
export function readableSkillsDirectories(
  options: InventoryRootOptions,
  scope: SkitBindingScope,
  harnesses: readonly HarnessName[] = HarnessName.literals,
) {
  return harnesses.flatMap((harness) => {
    const driver = harnessDrivers[harness];
    const own = driver.profile.roots
      .filter(
        (root) => root.readable && root.scope === (scope.kind === "global" ? "global" : "project"),
      )
      .map((root) =>
        resolveSkillsDirectory(root, {
          home: options.home,
          configHome: options.configHome,
          ...(scope.kind === "repository" ? { repository: scope.root } : {}),
        }),
      );
    const override = scope.kind === "global" ? options.overrides[harness] : undefined;
    const roots =
      override === undefined
        ? own
        : driver.rootOverride === "extends"
          ? [...own, ...override]
          : override;
    return roots.map((root) => ({ harness, root: resolve(root) }));
  });
}

/** Preserve the listing path even when a parent/root itself is a symlink. */
export const readSkillSymlink = Effect.fn("Projection.readSkillSymlink")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  for (let component = resolve(path); ; component = dirname(component)) {
    const info = yield* links.lstat(component);
    if (info.type === "SymbolicLink")
      return {
        path: resolve(path),
        via: "symlink" as const,
        linkPath: component,
        linkTarget: yield* fs.readLink(component),
      };
    if (component === dirname(component)) break;
  }
  return { path: resolve(path), via: "directory" as const };
});

export const DuplicateScanError = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
});
export type DuplicateScanError = typeof DuplicateScanError.Type;

/** Observe direct skill children only; unrelated unreadable entries never discard the index. */
export const scanSkillsDirectory = Effect.fn("Projection.scanSkillsDirectory")(function* (
  roots: readonly { readonly harness: HarnessName; readonly root: string }[],
  options: {
    readonly blockingNames?: readonly string[];
    readonly errors?: DuplicateScanError[];
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const instances = new Map<string, DuplicateCopy>();
  for (const { harness, root } of roots) {
    const names = yield* fs.readDirectory(root).pipe(
      Effect.catchTag("PlatformError", (error) => {
        if (error.reason._tag === "NotFound") return Effect.succeed([]);
        options.errors?.push({ path: root, message: String(error) });
        return options.blockingNames?.length ? Effect.fail(error) : Effect.succeed([]);
      }),
    );
    if (names.length > 4096) {
      const error = {
        path: root,
        message: "Skills directory exceeds the 4096-entry observation limit",
      };
      options.errors?.push(error);
      if (options.blockingNames?.length) return yield* new DuplicateScanIncomplete(error);
      continue;
    }
    for (const entry of names.sort()) {
      if (entry.startsWith(".")) continue;
      const path = join(root, entry);
      yield* Effect.gen(function* () {
        const info = yield* fs.stat(path);
        if (info.type !== "Directory") return;
        const document = join(path, "SKILL.md");
        const text = yield* fs.readFileString(document);
        const fields = parseSkillFrontmatter(text);
        const name = typeof fields?.name === "string" && fields.name ? fields.name : entry;
        const alias = yield* readSkillSymlink(path);
        const canonicalPath = yield* fs.realPath(path);
        const key = `${harness}\0${canonicalPath}`;
        const prior = instances.get(key);
        instances.set(key, {
          name,
          harness,
          canonicalPath,
          aliases: [...(prior?.aliases ?? []).filter((item) => item.path !== alias.path), alias],
          documentDigest: "sha256:" + createHash("sha256").update(text).digest("hex"),
        });
      }).pipe(
        Effect.catchTag("PlatformError", (error: PlatformError) => {
          if (error.reason._tag === "NotFound") return Effect.void;
          options.errors?.push({ path, message: String(error) });
          return options.blockingNames?.includes(entry) ? Effect.fail(error) : Effect.void;
        }),
      );
    }
  }
  return [...instances.values()].sort(
    (a, b) => a.harness.localeCompare(b.harness) || a.canonicalPath.localeCompare(b.canonicalPath),
  );
});

export class DuplicateScanIncomplete
  extends Data.TaggedError("DuplicateScanIncomplete")<{
    path: string;
    message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Inspect the skills directory before enabling another copy.";
}

/** Exclude the destinations we will reconcile together; other same-scope copies are duplicates. */
export const findDuplicates = Effect.fn("Projection.findDuplicates")(function* (
  options: InventoryRootOptions,
  scope: SkitBindingScope,
  names: readonly string[],
  errors?: DuplicateScanError[],
) {
  const fs = yield* FileSystem.FileSystem;
  const targets = yield* activeInstallDestinations(options);
  const roots = readableSkillsDirectories(options, scope);
  const destinations = targets.flatMap((target) =>
    names.map((name) => join(bindingRoot(target, scope, options), name)),
  );
  const canonicalDestinations = new Set(
    yield* Effect.forEach(destinations, (path) =>
      fs.realPath(dirname(path)).pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(resolve(dirname(path)))
            : Effect.fail(error),
        ),
        Effect.map((parent) => join(parent, basename(path))),
      ),
    ),
  );
  const canonicalRoots = yield* Effect.forEach(roots, ({ harness, root }) =>
    fs.realPath(root).pipe(
      Effect.catchTag("PlatformError", () => Effect.succeed(root)),
      Effect.map((canonicalRoot) => ({ harness, canonicalRoot })),
    ),
  );
  const readers = new Set(
    canonicalRoots
      .filter(({ canonicalRoot }) =>
        [...canonicalDestinations].some((destination) => dirname(destination) === canonicalRoot),
      )
      .map(({ harness }) => harness),
  );
  const instances = yield* scanSkillsDirectory(
    roots.filter(({ harness }) => readers.has(harness)),
    { blockingNames: names, errors },
  );
  return instances
    .filter((instance) => names.includes(instance.name))
    .map((instance) => ({
      ...instance,
      // SKIT's own destination is not another copy, unless a link sits there. SKIT never writes a
      // link, so one there is the user's: often a skill kept elsewhere and linked in on purpose.
      // Projecting would replace it, so it needs the same decision as any other agent copy.
      aliases: instance.aliases.filter(
        (alias) => !destinations.includes(alias.path) || isEntryLink(alias),
      ),
    }))
    .filter(
      (instance) =>
        instance.aliases.length > 0 &&
        // A copy already at a destination is SKIT's to manage, not a duplicate of itself; it still
        // counts when another destination links to it, as skills.sh links `.claude` to `.agents`.
        (!canonicalDestinations.has(instance.canonicalPath) || instance.aliases.some(isEntryLink)),
    );
});

/** Enabling would replace the user's own link where SKIT writes the copy; keeping both is impossible. */
export class InstalledSkillWouldReplaceLink
  extends Data.TaggedError("InstalledSkillWouldReplaceLink")<{ links: readonly string[] }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation =
    "Remove the link and enable again, or run `skit setup` and choose `--duplicates retire-aliases` to back it up with a move record.";
  get message() {
    return `Enabling would replace the link at ${this.links.join(", ")} with SKIT's copy, so both cannot be kept`;
  }
}

export class InstalledSkillWouldDuplicate
  extends Data.TaggedError("InstalledSkillWouldDuplicate")<{
    duplicates: readonly DuplicateCopy[];
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation =
    "Remove the redundant agent location, retain without enabling, or explicitly use --allow-duplicate.";
  get message() {
    return `Enabling would create duplicate skills: ${this.duplicates.flatMap((item) => item.aliases.map((alias) => `${item.name} (${item.harness}): ${alias.path}${alias.via === "symlink" ? ` -> ${item.canonicalPath} (symlink${alias.linkPath !== alias.path ? ` at ${alias.linkPath} -> ${alias.linkTarget}` : ""})` : ""}`)).join("; ")}`;
  }
}
