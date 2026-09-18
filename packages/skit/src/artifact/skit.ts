import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import type {
  Digest,
  SkillAssessmentContext,
  SkillAssessmentAcceptance,
  SkillExampleRecord,
  SkitDescriptor,
  SkitFileRecord,
  SkitReleaseIdentity,
  SkitValidationDiagnostic,
  ValidatedSkit,
} from "../contracts.js";
import { auditSkill, evaluateSkillAudit } from "../auditing/skill-audit.js";
import {
  assessInvocationConformance,
  describeInvocationConformanceIssue,
} from "../invocation/conformance.js";
import { walkTreeEffect, type TreeEntry } from "./tree.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
import type { TreeError } from "../shared/tree-error.js";
import {
  hashParts,
  hashProjectedSkillFiles,
  parseSkillExample,
  parseSkitConfigEffect,
  parseSkitReadmeEffect,
} from "./descriptor.js";
import {
  type DescriptorFailure,
  HarnessMetadataInvalid,
  ProjectedPathCollision,
  SharedTargetCollision,
} from "../failures.js";

export function readSkitDescriptorEffect(
  root: string,
): Effect.Effect<SkitDescriptor, DescriptorFailure | PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // A missing skit.json falls back to the README; any other read failure is real.
    const config = yield* fs
      .readFileString(resolve(root, "skit.json"))
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
    if (config !== undefined) return yield* parseSkitConfigEffect(config);
    const readme = yield* fs.readFileString(resolve(root, "README.md"));
    return yield* parseSkitReadmeEffect(readme);
  });
}

export function deterministicTreeHashEffect(
  root: string,
): Effect.Effect<Digest, TreeError | PlatformError, TreeRequirements> {
  return walkTreeEffect(root, "normalized").pipe(Effect.map(hashNormalizedEntries));
}

export function hashNormalizedEntries(entries: readonly TreeEntry[]): Digest {
  return hashParts(
    entries.flatMap((entry) =>
      entry.kind === "file" ? [entry.path, String(entry.mode), entry.bytes] : [],
    ),
  );
}

function releaseIdentityFromEntries(
  descriptor: SkitDescriptor,
  tree: TreeEntry[],
  release: string,
  releaseContentHash?: Digest,
): SkitReleaseIdentity {
  const files = tree.flatMap((entry) =>
    entry.kind === "file"
      ? [{ path: entry.path, bytes: entry.bytes, executable: entry.mode === 0o755 }]
      : [],
  );
  const skills = descriptor.skills.map((skill) => ({
    name: skill.name,
    contentHash: hashProjectedSkillFiles(files, skill.path, skill.shared),
    enabled: skill.default_enabled,
  }));
  return {
    slug: descriptor.slug,
    release,
    releaseContentHash: releaseContentHash ?? hashNormalizedEntries(tree),
    skills,
  };
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

export function inventorySkitFilesEffect(
  root: string,
): Effect.Effect<SkitFileRecord[], TreeError | PlatformError, TreeRequirements> {
  return walkTreeEffect(root, "normalized", { respectGitIgnore: true }).pipe(
    Effect.map(inventoryEntries),
  );
}

function inventoryEntries(entries: TreeEntry[]): SkitFileRecord[] {
  return entries.flatMap((entry) => {
    if (entry.kind !== "file") return [];
    const extension = posix.extname(entry.path).toLowerCase();
    return [
      {
        path: entry.path,
        digest: `sha256:${createHash("sha256").update(entry.bytes).digest("hex")}` as Digest,
        bytes: entry.bytes.byteLength,
        mediaType: MIME[extension] ?? "application/octet-stream",
        executable: entry.mode === 0o755,
      },
    ];
  });
}

export function validateSkitDirectoryEffect(
  root: string,
  release = "draft",
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
  | ProjectedPathCollision
  | HarnessMetadataInvalid
  | TreeError
  | PlatformError,
  TreeRequirements | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const descriptor = yield* readSkitDescriptorEffect(root);
    const tree = yield* walkTreeEffect(root, "normalized", {
      respectGitIgnore:
        options.assessmentContext === "author" || options.assessmentContext === "publish",
    });
    const files = inventoryEntries(tree);
    const identity = yield* Effect.try({
      try: () => releaseIdentityFromEntries(descriptor, tree, release),
      catch: (error) => {
        if (error instanceof SharedTargetCollision || error instanceof ProjectedPathCollision)
          return error;
        throw error;
      },
    });
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
          message: "Contained skills require a primary SKILL.md",
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
            message: `Shared mapping source for ${skill.name} does not exist`,
          });
        if (mapping.to.startsWith("../"))
          diagnostics.push({
            code: "SHARED_TARGET_TRAVERSAL",
            severity: "error",
            path: mapping.to,
            message: "Shared mapping target escapes the child skill",
          });
      }
      if (filePaths.has(primary)) {
        const body = yield* fs.readFileString(resolve(root, primary));
        const audit = auditSkill(body, {
          declaredCapabilities: skill.capabilities ?? [],
          path: primary,
          fingerprintPath: "SKILL.md",
          artifactContentDigest: identity.skills.find((item) => item.name === skill.name)!
            .contentHash,
        });
        audits[`${descriptor.slug}:${skill.name}`] = audit;
        const decision =
          "acceptances" in options
            ? evaluateSkillAudit(audit, {
                context: options.assessmentContext,
                artifactContentDigest: identity.skills.find((item) => item.name === skill.name)!
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
            message: `Security assessment ${decision.outcome}: ${decision.reasons.map((reason) => reason.code).join(", ")}`,
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
      // assessInvocationConformance is shared with the Registry Worker, which has no `effect`
      // dependency, so it still throws HarnessMetadataInvalid rather than returning a Result.
      const conformance = yield* Effect.try({
        try: () =>
          assessInvocationConformance(descriptor.skills, (path) => {
            const content = bytes.get(path);
            return content === undefined ? undefined : decoder.decode(content);
          }),
        catch: (error) => {
          if (error instanceof HarnessMetadataInvalid) return error;
          throw error;
        },
      });
      for (const issue of conformance)
        diagnostics.push({
          code: "INVOCATION_METADATA_MISMATCH",
          severity: options.assessmentContext === "publish" ? "error" : "warning",
          path: issue.path,
          message: describeInvocationConformanceIssue(issue),
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
          message: "Declared capability path does not exist",
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
          message: String(source.failure),
        });
        continue;
      }
      try {
        const manifest = parseSkillExample(source.success);
        const [, directorySkill, directoryId] = match;
        if (manifest.skill !== directorySkill || manifest.id !== directoryId)
          diagnostics.push({
            code: "EXAMPLE_PATH_IDENTITY_MISMATCH",
            severity: "error",
            path: file.path,
            message: "Example skill and id must match examples/<skill>/<id>/case.yaml",
          });
        if (!skillNames.has(manifest.skill))
          diagnostics.push({
            code: "EXAMPLE_SKILL_UNKNOWN",
            severity: "error",
            path: file.path,
            message: `Example references undeclared skill ${manifest.skill}`,
          });
        const key = `${manifest.skill}:${manifest.id}`;
        if (exampleKeys.has(key))
          diagnostics.push({
            code: "EXAMPLE_ID_DUPLICATE",
            severity: "error",
            path: file.path,
            message: `Duplicate example identity ${key}`,
          });
        exampleKeys.add(key);
        const base = posix.dirname(file.path);
        const references = [
          { path: manifest.prompt.path, kind: "prompt" },
          ...(manifest.execution.fixtures ?? []).map((path) => ({ path, kind: "fixture" })),
          ...(manifest.screenshots ?? []).map((screenshot) => ({
            path: screenshot.path,
            kind: "screenshot",
          })),
        ];
        for (const reference of references) {
          const referencedPath = posix.join(base, reference.path);
          const referencedFile = files.find((candidate) => candidate.path === referencedPath);
          if (!referencedFile)
            diagnostics.push({
              code: `EXAMPLE_${reference.kind.toUpperCase()}_MISSING`,
              severity: "error",
              path: referencedPath,
              message: `Example ${reference.kind} does not exist`,
            });
          else if (
            reference.kind === "screenshot" &&
            !referencedFile.mediaType.startsWith("image/")
          )
            diagnostics.push({
              code: "EXAMPLE_SCREENSHOT_MEDIA_INVALID",
              severity: "error",
              path: referencedPath,
              message: "Example screenshot must use an image media type",
            });
        }
        examples.push({ path: file.path, manifest });
      } catch (error) {
        diagnostics.push({
          code: "EXAMPLE_MANIFEST_INVALID",
          severity: "error",
          path: file.path,
          message: error instanceof Error ? error.message : "Example manifest is invalid",
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
