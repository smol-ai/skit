import type { PlatformError } from "effect/PlatformError";
import { basename, dirname, join, resolve } from "node:path";
import { Effect, FileSystem, Order } from "effect";
import { parseSkillFrontmatter } from "../harnesses/frontmatter.js";
import { LinkStat } from "../platform/link-stat.js";
import { sha256Hash } from "../shared/hash.js";
import type { HarnessName } from "../harnesses/contracts.js";
import {
  Duplicate,
  DuplicateScanIncomplete,
  Warning,
  type Destination,
} from "./installed-skill-facts.js";

/** Another copy of a skill, as an agent reads it, and every path it is reached by. */
export const DuplicateCopy = Duplicate;
export type DuplicateCopy = typeof DuplicateCopy.Type;
export const SkillAlias = Duplicate.fields.aliases.value;
export type SkillAlias = typeof SkillAlias.Type;

/**
 * Whether this entry is itself a symlink. A path reached through a linked parent (macOS `/var` is
 * a link to `/private/var`) is also reported `via: "symlink"`, but the skill entry there is an
 * ordinary directory and replacing it removes no link.
 */
export const isEntryLink = (alias: SkillAlias): boolean =>
  alias.via === "symlink" && alias.linkPath === alias.path;

/** Preserve the listing path even when a parent/root itself is a symlink. */
const readSkillSymlink = Effect.fn("Install.readSkillSymlink")(function* (path: string) {
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

export const DuplicateScanError = Warning;
export type DuplicateScanError = typeof DuplicateScanError.Type;

/** A skills directory an agent reads. */
export interface ReadableRoot {
  readonly harness: HarnessName;
  readonly root: string;
}

/** Observe direct skill children only; unrelated unreadable entries never discard the index. */
export const scanSkillsDirectory = Effect.fn("Install.scanSkillsDirectory")(function* (
  roots: readonly ReadableRoot[],
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
        options.errors?.push({ path: root, reason: { _tag: "Unreadable", error } });
        return options.blockingNames?.length ? Effect.fail(error) : Effect.succeed([]);
      }),
    );
    if (names.length > 4096) {
      const error = {
        path: root,
        reason: { _tag: "EntryLimitExceeded" as const, limit: 4096, count: names.length },
      };
      options.errors?.push(error);
      if (options.blockingNames?.length) return yield* new DuplicateScanIncomplete(error);
      continue;
    }
    for (const entry of names.sort(Order.String)) {
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
          documentHash: yield* sha256Hash(new TextEncoder().encode(text)),
        });
      }).pipe(
        Effect.catchTag("PlatformError", (error: PlatformError) => {
          if (error.reason._tag === "NotFound") return Effect.void;
          options.errors?.push({ path, reason: { _tag: "Unreadable", error } });
          return options.blockingNames?.includes(entry) ? Effect.fail(error) : Effect.void;
        }),
      );
    }
  }
  return [...instances.values()].sort(
    (a, b) => a.harness.localeCompare(b.harness) || a.canonicalPath.localeCompare(b.canonicalPath),
  );
});

/**
 * Other copies of `names` that agents read in `readable`, beside the `destinations` SKIT installs
 * into for the same scope. Excludes the destinations reconciled together; other same-scope copies
 * are duplicates.
 */
export const findDuplicates = Effect.fn("Install.findDuplicates")(function* (
  routing: {
    readonly destinations: readonly Destination[];
    readonly readable: readonly ReadableRoot[];
  },
  names: readonly string[],
  errors?: DuplicateScanError[],
) {
  const fs = yield* FileSystem.FileSystem;
  const destinations = routing.destinations.flatMap((target) =>
    names.map((name) => join(target.root, name)),
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
  const canonicalRoots = yield* Effect.forEach(routing.readable, ({ harness, root }) =>
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
    routing.readable.filter(({ harness }) => readers.has(harness)),
    { blockingNames: names, ...(errors === undefined ? {} : { errors }) },
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
