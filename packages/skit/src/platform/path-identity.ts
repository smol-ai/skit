import { Effect } from "effect";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PlatformError } from "effect/PlatformError";
import { LinkStat, type PathStats } from "./link-stat.js";

export interface ObservationPathIdentity {
  /** Resolved, displayable path for this observation pass. Not a durable target identifier. */
  canonicalPath: string;
  /** Equality key valid only within the current filesystem observation pass. */
  comparisonKey: string;
}

export interface ProjectionTargetPathIdentity {
  /** Absolute configured or routed path retained for collision diagnostics. */
  declaredPath: string;
  /** Byte-faithful physical path. Absent until the complete target resolves. */
  canonicalPath?: string;
  /** Evidence for grouping route candidates that resolve, or may resolve, to one target. */
  comparisonKey: string;
}

export interface ProjectionTargetCandidateGroup {
  comparisonKey: string;
  candidates: ProjectionTargetPathIdentity[];
  /** A lone unresolved candidate may materialize normally; only competing declarations block. */
  ambiguous: boolean;
}

/** Compare lexical containment through the same path boundary used by target identity. */
export function pathIsWithin(root: string, path: string): boolean {
  const candidate = relative(resolve(root), resolve(path));
  return candidate === "" || (candidate.split(sep)[0] !== ".." && !isAbsolute(candidate));
}

/**
 * Identify aliases of one physical path during a single inventory or audit pass.
 *
 * This deliberately does not define durable Projection Target identity. Inode identity changes on
 * atomic replacement, and a symlink may later be retargeted. Durable declared-path and relocation
 * semantics belong to the Projection Target model rather than this observation helper.
 */
export function observationPathIdentityEffect(
  path: string,
): Effect.Effect<ObservationPathIdentity, never, LinkStat> {
  return Effect.gen(function* () {
    const probe = yield* LinkStat;
    const canonicalPath = yield* probe
      .realPathNative(path)
      .pipe(Effect.orElseSucceed(() => resolve(path)));
    const info = yield* Effect.option(probe.identity.stat(canonicalPath));
    return info._tag === "Some"
      ? { canonicalPath, comparisonKey: `device:${info.value.dev}:inode:${info.value.ino}` }
      : { canonicalPath, comparisonKey: `path:${canonicalPath.normalize("NFC")}` };
  });
}

function alternateCase(value: string): string | undefined {
  const index = value.search(/[A-Za-z]/);
  if (index < 0) return undefined;
  const character = value[index]!;
  const replacement =
    character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

function resolvesCaseInsensitively(existingPath: string): Effect.Effect<boolean, never, LinkStat> {
  return Effect.gen(function* () {
    const probe = yield* LinkStat;
    let candidate = existingPath;
    while (dirname(candidate) !== candidate) {
      const alternateName = alternateCase(basename(candidate));
      if (alternateName) {
        // A case-sensitive component, or one with no accessible alternate spelling, is not evidence.
        const pair = yield* Effect.option(
          Effect.all([
            probe.identity.stat(candidate),
            probe.identity.stat(join(dirname(candidate), alternateName)),
          ]),
        );
        if (pair._tag === "Some") {
          const [original, alternate] = pair.value;
          return original.dev === alternate.dev && original.ino === alternate.ino;
        }
      }
      candidate = dirname(candidate);
    }
    return false;
  });
}

function nearestExistingAncestor(
  path: string,
): Effect.Effect<{ path: string; canonicalPath: string }, never, LinkStat> {
  return Effect.gen(function* () {
    const probe = yield* LinkStat;
    let candidate = path;
    while (true) {
      const resolved = yield* Effect.option(probe.realPathNative(candidate));
      if (resolved._tag === "Some") return { path: candidate, canonicalPath: resolved.value };
      const parent = dirname(candidate);
      if (parent === candidate) return { path: candidate, canonicalPath: candidate };
      candidate = parent;
    }
  });
}

/**
 * Describe comparison evidence for a routed Projection Target candidate.
 *
 * Existing targets use byte-faithful realpath identity. An unresolved target is grouped by its
 * nearest existing ancestor and normalized relative suffix. Case folding is used only when the
 * filesystem proves an alternate spelling resolves to that same ancestor. The comparison key is
 * evidence for pre-mutation collision detection, not a persisted identity.
 */
export function projectionTargetPathIdentityEffect(
  path: string,
): Effect.Effect<ProjectionTargetPathIdentity, PlatformError, LinkStat> {
  return Effect.gen(function* () {
    const probe = yield* LinkStat;
    const declaredPath = resolve(path);
    const resolved = yield* Effect.option(
      Effect.gen(function* () {
        const canonicalPath = yield* probe.realPathNative(declaredPath);
        const info: PathStats = yield* probe.identity.stat(canonicalPath);
        return { canonicalPath, info };
      }),
    );
    if (resolved._tag === "Some")
      return {
        declaredPath,
        canonicalPath: resolved.value.canonicalPath,
        comparisonKey: `device:${resolved.value.info.dev}:inode:${resolved.value.info.ino}`,
      };
    const ancestor = yield* nearestExistingAncestor(declaredPath);
    // Unlike the resolved branch, an unreadable ancestor is a real failure, not a fallback.
    const info = yield* probe.identity.stat(ancestor.canonicalPath);
    let suffix = relative(ancestor.path, declaredPath).normalize("NFC");
    if (yield* resolvesCaseInsensitively(ancestor.canonicalPath))
      suffix = suffix.toLocaleLowerCase("und");
    return { declaredPath, comparisonKey: `unresolved:${info.dev}:${info.ino}:${suffix}` };
  });
}

/** Group possible aliases without treating a single new target as ambiguous. */
export function groupProjectionTargetCandidatesEffect(
  paths: readonly string[],
): Effect.Effect<ProjectionTargetCandidateGroup[], PlatformError, LinkStat> {
  return Effect.gen(function* () {
    const groups = new Map<string, ProjectionTargetPathIdentity[]>();
    for (const path of paths) {
      const candidate = yield* projectionTargetPathIdentityEffect(path);
      const group = groups.get(candidate.comparisonKey) ?? [];
      group.push(candidate);
      groups.set(candidate.comparisonKey, group);
    }
    return [...groups].map(([comparisonKey, candidates]) => ({
      comparisonKey,
      candidates,
      ambiguous:
        candidates[0]?.canonicalPath === undefined &&
        new Set(candidates.map((candidate) => candidate.declaredPath)).size > 1,
    }));
  });
}

/** Report a symlinked artifact or immediate containing directory from filesystem evidence. */
export function artifactUsesSymlinkEffect(path: string): Effect.Effect<boolean, never, LinkStat> {
  return Effect.gen(function* () {
    const probe = yield* LinkStat;
    for (const candidate of [resolve(path), dirname(resolve(path))]) {
      // A missing or unreadable artifact is not affirmative symlink evidence.
      const info = yield* Effect.option(probe.identity.lstat(candidate));
      if (info._tag === "Some" && info.value.type === "SymbolicLink") return true;
    }
    return false;
  });
}
