import {
  assessInvocationConformance,
  auditSkill,
  canonicalJson,
  describeInvocationConformanceIssue,
  evaluateSkillAudit,
  parseSkitConfig,
  parseSkitReadme,
  type RegistrySkitDescriptor,
} from "@smolai/skit-core/universal/consumer";
import type { IntegrityErrorCode } from "@smolai/skit-core/universal/api";
import {
  MAX_ARTIFACT_CONTENT_BYTES,
  MAX_ARTIFACT_FILES,
} from "@smolai/skit-core/universal/authoring";
import { Effect } from "effect";
import { type ArtifactFile, IntegrityError, type ValidationDiagnostic } from "./contracts.js";
import { projectionLimitExceeded } from "./projection-limits.js";
import {
  descriptorError,
  hashProjectedSkillFiles,
  normalizeDescriptorDeclarations,
  projectSkillFiles,
} from "./descriptor.js";

export interface ValidatedArtifactBundle {
  readonly descriptor: RegistrySkitDescriptor;
  readonly diagnostics: ReadonlyArray<ValidationDiagnostic>;
}

const fail = (code: IntegrityErrorCode, detail?: string) =>
  Effect.fail(new IntegrityError({ code, ...(detail === undefined ? {} : { detail }) }));

export const validateArtifactBundle = Effect.fn("Integrity.validateArtifactBundle")(function* (
  owner: string,
  slug: string,
  descriptorInput: unknown,
  files: ReadonlyArray<ArtifactFile>,
) {
  if (files.length < 1 || files.length > MAX_ARTIFACT_FILES) return yield* fail("INVALID_DRAFT");
  if (new Set(files.map(({ path }) => path)).size !== files.length)
    return yield* fail("DUPLICATE_FILE_PATH");
  if (files.some(({ bytes }) => bytes.byteLength > MAX_ARTIFACT_CONTENT_BYTES))
    return yield* fail("DRAFT_FILE_TOO_LARGE");
  if (files.reduce((total, { bytes }) => total + bytes.byteLength, 0) > MAX_ARTIFACT_CONTENT_BYTES)
    return yield* fail("DRAFT_TOO_LARGE");

  const config = files.find(({ path }) => path === "skit.json");
  const readme = files.find(({ path }) => path === "README.md");
  const localDescriptor = config
    ? yield* parseSkitConfig(new TextDecoder().decode(config.bytes)).pipe(
        Effect.mapError(descriptorError),
      )
    : readme
      ? yield* parseSkitReadme(new TextDecoder().decode(readme.bytes)).pipe(
          Effect.mapError(descriptorError),
        )
      : yield* fail("DESCRIPTOR_MISSING");
  if (localDescriptor.slug !== slug) return yield* fail("INVALID_DESCRIPTOR_ID");
  const descriptor: RegistrySkitDescriptor = { ...localDescriptor, id: `${owner}/${slug}` };
  const normalizedLocal = yield* normalizeDescriptorDeclarations(descriptor);
  const normalizedInput = yield* normalizeDescriptorDeclarations(descriptorInput);
  if (canonicalJson(normalizedLocal) !== canonicalJson(normalizedInput))
    return yield* fail("DESCRIPTOR_CONTENT_MISMATCH");

  const paths = new Set(files.map(({ path }) => path));
  const text = new TextDecoder();
  const diagnostics: Array<ValidationDiagnostic> = [];
  const overLimit = projectionLimitExceeded(files, descriptor.skills);
  if (overLimit) return yield* fail(overLimit.code, overLimit.path);
  for (const skill of descriptor.skills) {
    const primary = `${skill.path}/SKILL.md`;
    const primaryFile = files.find(({ path }) => path === primary);
    if (!primaryFile) return yield* fail("SKILL_FILE_MISSING", primary);
    for (const mapping of skill.shared ?? []) {
      if (!files.some(({ path }) => path === mapping.from || path.startsWith(`${mapping.from}/`)))
        return yield* fail("SHARED_SOURCE_MISSING", mapping.from);
    }
    yield* projectSkillFiles(files, skill.path, skill.shared);
    const decision = evaluateSkillAudit(
      auditSkill(text.decode(primaryFile.bytes), {
        declaredCapabilities: [...(skill.capabilities ?? [])],
        path: primary,
        artifactContentDigest: yield* hashProjectedSkillFiles(files, skill.path, skill.shared),
      }),
      { context: "publish" },
    );
    // A `warn` outcome is advisory; only `block` gates publication.
    if (decision.outcome === "block")
      diagnostics.push({
        code: "SECURITY_POLICY_BLOCKED",
        severity: "error",
        path: primary,
        message: `Security assessment block: ${decision.reasons.map((reason) => reason.code).join(", ")}`,
      });
  }

  const contents = new Map(files.map((file) => [file.path, text.decode(file.bytes)]));
  const conformance = yield* Effect.fromResult(
    assessInvocationConformance(descriptor.skills, (path) => contents.get(path)),
  ).pipe(
    Effect.mapError(
      (failure) =>
        new IntegrityError({ code: "INVALID_INVOCATION_METADATA", detail: failure.path }),
    ),
  );
  for (const issue of conformance)
    diagnostics.push({
      code: "INVOCATION_METADATA_MISMATCH",
      severity: "error",
      path: issue.path,
      message: describeInvocationConformanceIssue(issue),
    });

  for (const path of [
    ...(descriptor.capabilities?.executables ?? []),
    ...(descriptor.capabilities?.hooks ?? []),
    ...(descriptor.capabilities?.mcp ?? []),
  ])
    if (!paths.has(path)) return yield* fail("CAPABILITY_PATH_MISSING", path);

  return { descriptor, diagnostics } satisfies ValidatedArtifactBundle;
});
