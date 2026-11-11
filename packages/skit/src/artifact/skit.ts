import { Effect, FileSystem, Result } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import { type Hash, encodeHashParts, sha256Hash } from "../shared/hash.js";
import type { SkillAssessmentContext } from "../auditing/skill-contracts.js";
import type { SkillAssessmentAcceptance } from "../library/assessment-acceptance.js";
import type {
  SkillExampleRecord,
  SkitFileRecord,
  SkitReleaseIdentity,
  ValidatedSkit,
} from "./contracts.js";
import type { SkitDescriptor } from "./schemas.js";
import type { SkitValidationDiagnostic } from "./validation-diagnostic.js";
import { auditSkill, evaluateSkillAudit } from "../auditing/skill-audit.js";
import { assessInvocationConformance } from "../invocation/conformance.js";
import { walkTree } from "./tree.js";

import type { TreeEntry } from "./tree-entry.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
import type { TreeError } from "../shared/tree-error.js";
import {
  hashParts,
  hashInstalledSkillFiles,
  parseSkillExample,
  parseSkitConfig,
  parseSkitReadme,
} from "./descriptor.js";
import { type DescriptorFailure } from "./failures.js";
import { type HarnessMetadataInvalid } from "../harnesses/metadata-failures.js";
import {
  type InstalledPathCollision,
  type SharedTargetCollision,
} from "../installed-skills/failures.js";

export function readSkitDescriptor(
  root: string,
): Effect.Effect<SkitDescriptor, DescriptorFailure | PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // A missing skit.json falls back to the README; any other read failure is real.
    const config = yield* fs
      .readFileString(resolve(root, "skit.json"))
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
    if (config !== undefined) return yield* parseSkitConfig(config);
    const readme = yield* fs.readFileString(resolve(root, "README.md"));
    return yield* parseSkitReadme(readme);
  });
}

export function deterministicTreeHash(
  root: string,
): Effect.Effect<Hash, TreeError | PlatformError, TreeRequirements> {
  return walkTree(root, "normalized").pipe(Effect.map(hashNormalizedEntries));
}

/** What a normalized tree's hash covers: each file's path, mode and bytes. */
const normalizedHashParts = (entries: readonly TreeEntry[]) =>
  entries.flatMap((entry) =>
    entry.kind === "file" ? [entry.path, String(entry.mode), entry.bytes] : [],
  );

function hashNormalizedEntries(entries: readonly TreeEntry[]): Hash {
  return hashParts(normalizedHashParts(entries));
}

/** `deterministicTreeHash`, computed through Effect's Digest service. The same hash. */
export const hashTree = (root: string) =>
  walkTree(root, "normalized").pipe(
    Effect.flatMap((entries) => sha256Hash(encodeHashParts(normalizedHashParts(entries)))),
  );

function releaseIdentityFromEntries(
  descriptor: SkitDescriptor,
  tree: TreeEntry[],
  release: string,
  releaseContentHash?: Hash,
): Result.Result<SkitReleaseIdentity, SharedTargetCollision | InstalledPathCollision> {
  const files = tree.flatMap((entry) =>
    entry.kind === "file"
      ? [{ path: entry.path, bytes: entry.bytes, executable: entry.mode === 0o755 }]
      : [],
  );
  return Result.map(
    Result.all(
      descriptor.skills.map((skill) =>
        Result.map(hashInstalledSkillFiles(files, skill.path, skill.shared), (contentHash) => ({
          name: skill.name,
          contentHash,
          enabled: skill.default_enabled,
        })),
      ),
    ),
    (skills) => ({
      slug: descriptor.slug,
      release,
      releaseContentHash: releaseContentHash ?? hashNormalizedEntries(tree),
      skills,
    }),
  );
}

const MIME: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".ts": "text/typescript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function inventoryEntries(entries: TreeEntry[]): SkitFileRecord[] {
  return entries.flatMap((entry) => {
    if (entry.kind !== "file") return [];
    const extension = posix.extname(entry.path).toLowerCase();
    return [
      {
        path: entry.path,
        hash: `sha256:${createHash("sha256").update(entry.bytes).digest("hex")}` as Hash,
        bytes: entry.bytes.byteLength,
        mediaType: MIME[extension] ?? "application/octet-stream",
        executable: entry.mode === 0o755,
      },
    ];
  });
}

export function validateSkitDirectory(
  root: string,
  release = "unpublished",
  options:
    | {
        assessmentContext: SkillAssessmentContext;
      }
    | {
        assessmentContext: SkillAssessmentContext;
        acceptances: readonly SkillAssessmentAcceptance[];
        evaluatedAt: string;
      },
): Effect.Effect<
  ValidatedSkit,
  | DescriptorFailure
  | SharedTargetCollision
  | InstalledPathCollision
  | HarnessMetadataInvalid
  | TreeError
  | PlatformError,
  TreeRequirements | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const descriptor = yield* readSkitDescriptor(root);
    const tree = yield* walkTree(root, "normalized", {
      respectGitIgnore:
        options.assessmentContext === "author" || options.assessmentContext === "publish",
    });
    const files = inventoryEntries(tree);
    const identity = yield* Effect.fromResult(
      releaseIdentityFromEntries(descriptor, tree, release),
    );
    const filePaths = new Set(files.map((file) => file.path));
    const diagnostics: SkitValidationDiagnostic[] = [];
    const audits: ValidatedSkit["audits"] = {};
    const assessments: ValidatedSkit["assessments"] = {};
    const examples: SkillExampleRecord[] = [];
    for (const skill of descriptor.skills) {
      const primary = posix.join(skill.path, "SKILL.md");
      if (!filePaths.has(primary))
        diagnostics.push({
          code: "SKILL_FILE_MISSING",
          severity: "error",
          path: primary,
        });
      for (const mapping of skill.shared ?? []) {
        if (
          !filePaths.has(mapping.from) &&
          !files.some((file) => file.path.startsWith(`${mapping.from}/`))
        )
          diagnostics.push({
            code: "SHARED_SOURCE_MISSING",
            severity: "error",
            path: mapping.from,
            skill: skill.name,
          });
        if (mapping.to.startsWith("../"))
          diagnostics.push({
            code: "SHARED_TARGET_TRAVERSAL",
            severity: "error",
            path: mapping.to,
          });
      }
      if (filePaths.has(primary)) {
        const body = yield* fs.readFileString(resolve(root, primary));
        const audit = auditSkill(body, {
          declaredCapabilities: skill.capabilities ?? [],
          path: primary,
          fingerprintPath: "SKILL.md",
          artifactContentHash: identity.skills.find((item) => item.name === skill.name)!
            .contentHash,
        });
        audits[`${descriptor.slug}:${skill.name}`] = audit;
        const decision =
          "acceptances" in options
            ? evaluateSkillAudit(audit, {
                context: options.assessmentContext,
                artifactContentHash: identity.skills.find((item) => item.name === skill.name)!
                  .contentHash,
                acceptances: options.acceptances,
                evaluatedAt: options.evaluatedAt,
              })
            : evaluateSkillAudit(audit, { context: options.assessmentContext });
        assessments[`${descriptor.slug}:${skill.name}`] = decision;
        if (decision.outcome !== "allow")
          diagnostics.push({
            code:
              decision.outcome === "block"
                ? "SECURITY_POLICY_BLOCKED"
                : "SECURITY_ASSESSMENT_WARNING",
            severity: decision.outcome === "block" ? "error" : "warning",
            path: primary,
            assessment: decision,
          });
      }
    }
    if (options.assessmentContext === "author" || options.assessmentContext === "publish") {
      const bytes = new Map(
        tree.flatMap((entry) =>
          entry.kind === "file" ? [[entry.path, entry.bytes] as const] : [],
        ),
      );
      const decoder = new TextDecoder();
      const conformance = yield* Effect.fromResult(
        assessInvocationConformance(descriptor.skills, (path) => {
          const content = bytes.get(path);
          return content === undefined ? undefined : decoder.decode(content);
        }),
      );
      for (const issue of conformance)
        diagnostics.push({
          code: "INVOCATION_METADATA_MISMATCH",
          severity: options.assessmentContext === "publish" ? "error" : "warning",
          path: issue.path,
          issue,
        });
    }
    for (const declared of [
      ...(descriptor.capabilities?.executables ?? []),
      ...(descriptor.capabilities?.hooks ?? []),
      ...(descriptor.capabilities?.mcp ?? []),
    ]) {
      if (!filePaths.has(declared))
        diagnostics.push({
          code: "CAPABILITY_PATH_MISSING",
          severity: "error",
          path: declared,
        });
    }
    const skillNames = new Set(descriptor.skills.map((skill) => skill.name));
    const exampleKeys = new Set<string>();
    for (const file of files) {
      const match = file.path.match(/^examples\/([^/]+)\/([^/]+)\/case\.ya?ml$/);
      if (!match) continue;
      const source = yield* Effect.result(fs.readFileString(resolve(root, file.path)));
      if (source._tag === "Failure") {
        diagnostics.push({
          code: "EXAMPLE_MANIFEST_INVALID",
          severity: "error",
          path: file.path,
          reason: { _tag: "Unreadable", failure: source.failure },
        });
        continue;
      }
      const checked = yield* Effect.result(parseSkillExample(source.success));
      if (Result.isSuccess(checked)) {
        const manifest = checked.success;
        const [, directorySkill, directoryId] = match;
        if (manifest.skill !== directorySkill || manifest.id !== directoryId)
          diagnostics.push({
            code: "EXAMPLE_PATH_IDENTITY_MISMATCH",
            severity: "error",
            path: file.path,
            skill: manifest.skill,
            id: manifest.id,
            directorySkill,
            directoryId,
          });
        if (!skillNames.has(manifest.skill))
          diagnostics.push({
            code: "EXAMPLE_SKILL_UNKNOWN",
            severity: "error",
            path: file.path,
            skill: manifest.skill,
          });
        const key = `${manifest.skill}:${manifest.id}`;
        if (exampleKeys.has(key))
          diagnostics.push({
            code: "EXAMPLE_ID_DUPLICATE",
            severity: "error",
            path: file.path,
            skill: manifest.skill,
            id: manifest.id,
          });
        exampleKeys.add(key);
        const base = posix.dirname(file.path);
        const references = [
          { path: manifest.prompt.path, kind: "prompt", code: "EXAMPLE_PROMPT_MISSING" as const },
          ...(manifest.execution.fixtures ?? []).map((path) => ({
            path,
            kind: "fixture",
            code: "EXAMPLE_FIXTURE_MISSING" as const,
          })),
          ...(manifest.screenshots ?? []).map((screenshot) => ({
            path: screenshot.path,
            kind: "screenshot",
            code: "EXAMPLE_SCREENSHOT_MISSING" as const,
          })),
        ];
        for (const reference of references) {
          const referencedPath = posix.join(base, reference.path);
          const referencedFile = files.find((candidate) => candidate.path === referencedPath);
          if (!referencedFile)
            diagnostics.push({
              code: reference.code,
              severity: "error",
              path: referencedPath,
            });
          else if (
            reference.kind === "screenshot" &&
            !referencedFile.mediaType.startsWith("image/")
          )
            diagnostics.push({
              code: "EXAMPLE_SCREENSHOT_MEDIA_INVALID",
              severity: "error",
              path: referencedPath,
              mediaType: referencedFile.mediaType,
            });
        }
        examples.push({ path: file.path, manifest });
      } else {
        diagnostics.push({
          code: "EXAMPLE_MANIFEST_INVALID",
          severity: "error",
          path: file.path,
          reason: { _tag: "Malformed", issue: checked.failure.issue },
        });
      }
    }
    return {
      descriptor,
      files,
      identity,
      diagnostics,
      audits,
      assessments,
      examples,
    };
  });
}
