import type { PlatformError } from "effect/PlatformError";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import {
  LinkStat,
  harnessProfile,
  parseSkillFrontmatter,
  resolveHarnessRoot,
  type HarnessName,
  type SkitBindingScope,
} from "@smolai/skit-core";
import { activeProjectionTargetsEffect, bindingRoot, type InventoryRootOptions } from "./roots.js";

export const SkillAlias = Schema.Struct({
  path: Schema.String,
  via: Schema.Literals(["symlink", "directory", "unknown-root"]),
  linkPath: Schema.optionalKey(Schema.String),
  linkTarget: Schema.optionalKey(Schema.String),
});
export type SkillAlias = typeof SkillAlias.Type;
export const HarnessShadow = Schema.Struct({
  name: Schema.String,
  harness: Schema.String,
  canonicalPath: Schema.String,
  aliases: Schema.Array(SkillAlias),
  documentDigest: Schema.String,
});
export type HarnessShadow = typeof HarnessShadow.Type;
const harnesses: readonly HarnessName[] = ["codex", "claude-code", "opencode", "devin"];

export function readableHarnessRoots(options: InventoryRootOptions, scope: SkitBindingScope) {
  return harnesses.flatMap((harness) => {
    const override =
      harness === "codex"
        ? options.overrides.codex
        : harness === "claude-code"
          ? options.overrides.claude
          : harness === "opencode"
            ? options.overrides.opencode
            : options.overrides.devin;
    const roots =
      scope.kind === "global" && override !== undefined
        ? typeof override === "string"
          ? [override]
          : override
        : harnessProfile(harness)
            .roots.filter(
              (root) =>
                root.readable && root.scope === (scope.kind === "global" ? "global" : "project"),
            )
            .map((root) =>
              resolveHarnessRoot(root, {
                home: options.home,
                configHome: options.configHome,
                ...(scope.kind === "repository" ? { repository: scope.root } : {}),
              }),
            );
    return roots.map((root) => ({ harness, root: resolve(root) }));
  });
}

/** Preserve the listing path even when a parent/root itself is a symlink. */
export const observeSkillAlias = Effect.fn("Projection.observeAlias")(function* (path: string) {
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

export const ShadowObservationError = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
});
export type ShadowObservationError = typeof ShadowObservationError.Type;

/** Observe direct skill children only; unrelated unreadable entries never discard the index. */
export const observeHarnessSkills = Effect.fn("Projection.observeHarnessSkills")(function* (
  roots: readonly { readonly harness: HarnessName; readonly root: string }[],
  options: {
    readonly blockingNames?: readonly string[];
    readonly errors?: ShadowObservationError[];
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const instances = new Map<string, HarnessShadow>();
  for (const { harness, root } of roots) {
    const names = yield* fs.readDirectory(root).pipe(
      Effect.catchTag("PlatformError", (error) => {
        if (error.reason._tag === "NotFound") return Effect.succeed([]);
        options.errors?.push({ path: root, message: String(error) });
        return options.blockingNames?.length ? Effect.fail(error) : Effect.succeed([]);
      }),
    );
    if (names.length > 4096) {
      const error = { path: root, message: "Skill root exceeds the 4096-entry observation limit" };
      options.errors?.push(error);
      if (options.blockingNames?.length) return yield* new ShadowObservationIncomplete(error);
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
        const alias = yield* observeSkillAlias(path);
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

export class ShadowObservationIncomplete extends Schema.TaggedError<ShadowObservationIncomplete>()(
  "ShadowObservationIncomplete",
  { path: Schema.String, message: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Inspect the skill root before enabling another copy.";
}

/** Exclude the destinations we will reconcile together; other same-scope copies are shadows. */
export const observeHarnessShadows = Effect.fn("Projection.observeShadows")(function* (
  options: InventoryRootOptions,
  scope: SkitBindingScope,
  names: readonly string[],
  errors?: ShadowObservationError[],
) {
  const fs = yield* FileSystem.FileSystem;
  const targets = yield* activeProjectionTargetsEffect(options);
  const roots = readableHarnessRoots(options, scope);
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
  const instances = yield* observeHarnessSkills(
    roots.filter(({ harness }) => readers.has(harness)),
    { blockingNames: names, errors },
  );
  return instances
    .filter(
      (instance) =>
        names.includes(instance.name) && !canonicalDestinations.has(instance.canonicalPath),
    )
    .map((instance) => ({
      ...instance,
      aliases: instance.aliases.filter((alias) => !destinations.includes(alias.path)),
    }))
    .filter((instance) => instance.aliases.length > 0);
});

export class ProjectionWouldDuplicate extends Schema.TaggedError<ProjectionWouldDuplicate>()(
  "ProjectionWouldDuplicate",
  { shadows: Schema.Array(HarnessShadow) },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation =
    "Remove the redundant agent location, retain without enabling, or explicitly use --allow-duplicate.";
  get message() {
    return `Enabling would create duplicate skills: ${this.shadows.flatMap((item) => item.aliases.map((alias) => `${item.name} (${item.harness}): ${alias.path}${alias.via === "symlink" ? ` -> ${item.canonicalPath} (symlink${alias.linkPath !== alias.path ? ` at ${alias.linkPath} -> ${alias.linkTarget}` : ""})` : ""}`)).join("; ")}`;
  }
}
