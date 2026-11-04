import { Data, Effect, FileSystem } from "effect";
import { basename, dirname, join, relative } from "node:path";
import {
  deterministicTreeHash,
  readSkitDescriptor,
  validateSkitDirectory,
} from "../artifact/skit.js";
import { parseSkillFrontmatter } from "../harnesses/frontmatter.js";
import { leavePnpmSkill } from "../install/pnpm-skills.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { sourceLocator, type ResolvedSkitSource } from "../sources/resolve.js";
import { originalTreeHash } from "./collection-version.js";
import { prepareImport } from "./import-collection.js";
import type { SkitSource } from "./library-contracts.js";

export class AddNoSkills
  extends Data.TaggedError("Library.AddNoSkills")<{ source: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Choose a source that contains a SKILL.md.";
  get message(): string {
    return `No Skills found in ${this.source}`;
  }
}

/** Check every selected local member before retaining any bytes, including declared collections.
 * Preserve the caller's dependency view when resolution canonicalizes or stages directory links.
 */
export const leaveResolvedPnpmSkills = Effect.fn("Library.leaveResolvedPnpmSkills")(function* (
  source: SkitSource,
  resolved: ResolvedSkitSource,
) {
  if (source.type !== "local") return;
  const inputRoot = basename(source.path) === "SKILL.md" ? dirname(source.path) : source.path;
  if (resolved.descriptorKind === "declared") {
    const descriptor = yield* readSkitDescriptor(resolved.root);
    const memberRoot = join(inputRoot, relative(resolved.originalRoot, resolved.root));
    for (const skill of descriptor.skills) {
      yield* leavePnpmSkill(join(memberRoot, skill.path));
      yield* leavePnpmSkill(join(resolved.root, skill.path));
    }
  } else {
    for (const path of resolved.foundSkillPaths) {
      yield* leavePnpmSkill(join(inputRoot, path));
      yield* leavePnpmSkill(join(resolved.originalRoot, path));
    }
  }
});

/** Describe plain source members once, before retention verifies and stages those observations. */
export const describeSourceSkills = Effect.fn("Library.describeSourceSkills")(function* (
  resolved: Extract<ResolvedSkitSource, { descriptorKind: "observed" }>,
  sourceLabel: string,
) {
  if (resolved.foundSkillPaths.length === 0) return yield* new AddNoSkills({ source: sourceLabel });
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.forEach(resolved.foundSkillPaths, (relativePath) =>
    Effect.gen(function* () {
      const sourcePath =
        relativePath === "." ? resolved.originalRoot : join(resolved.originalRoot, relativePath);
      const text = yield* fs.readFileString(join(sourcePath, "SKILL.md"));
      const frontmatter = parseSkillFrontmatter(text);
      return {
        name:
          typeof frontmatter?.name === "string" && frontmatter.name.trim()
            ? frontmatter.name.trim()
            : basename(sourcePath),
        sourcePath,
        relativePath,
        currentHash: yield* deterministicTreeHash(sourcePath),
      };
    }),
  );
});

/** What a resolved Source would import: its kind, Skills and snapshot. Retains nothing. */
export const inspectResolvedSource = Effect.fn("Library.inspectResolvedSource")(function* (
  parsed: SkitSource,
  resolved: ResolvedSkitSource,
) {
  if (resolved.descriptorKind === "declared") {
    const validated = yield* validateSkitDirectory(resolved.root, "retained", {
      assessmentContext: "import",
    });
    return {
      kind: "authored" as const,
      snapshot_digest: yield* originalTreeHash(resolved.root),
      skills: validated.descriptor.skills.map((skill) => ({
        name: skill.name,
        verbatim_path: skill.path,
      })),
    };
  }
  const skills = yield* describeSourceSkills(resolved, sourceLocator(parsed));
  const diagnostics = resolved.diagnostics?.length ? { diagnostics: resolved.diagnostics } : {};
  const prepared = yield* prepareImport(skills);
  return {
    kind: "plain" as const,
    ...diagnostics,
    snapshot_digest: prepared.hash,
    skills: prepared.facts.map((skill) => ({
      name: skill.name,
      verbatim_path: skill.sourcePath,
    })),
    /** Per-Skill bytes, so a refresh preview can tell which Skills changed. */
    members: prepared.facts.map((skill) => ({
      source_path: skill.sourcePath,
      artifact_hash: skill.artifactHash,
    })),
  };
});
