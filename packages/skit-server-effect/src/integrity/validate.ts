import { Effect } from "effect";
import { publicationBlockReasons } from "./audit.js";
import {
  type ArtifactFile,
  IntegrityError,
  type IntegrityErrorCode,
  MAX_ARTIFACT_CONTENT_BYTES,
  type SkitDescriptor,
  type ValidationDiagnostic,
} from "./contracts.js";
import {
  canonical,
  hashProjectedSkillFiles,
  normalizeDescriptorDeclarations,
  parseSkitConfig,
  parseSkitReadme,
  projectSkillFiles,
} from "./descriptor.js";
import { assessInvocationConformance, describeInvocationConformanceIssue } from "./invocation.js";

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = MAX_ARTIFACT_CONTENT_BYTES;

export interface RegistryDescriptor extends SkitDescriptor {
  readonly id: string;
}

export interface ValidatedArtifactBundle {
  readonly descriptor: RegistryDescriptor;
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
  if (files.length < 1 || files.length > MAX_FILES) return yield* fail("INVALID_DRAFT");
  if (new Set(files.map(({ path }) => path)).size !== files.length)
    return yield* fail("DUPLICATE_FILE_PATH");
  if (files.some(({ bytes }) => bytes.byteLength > MAX_FILE_BYTES))
    return yield* fail("DRAFT_FILE_TOO_LARGE");
  if (files.reduce((total, { bytes }) => total + bytes.byteLength, 0) > MAX_ARTIFACT_CONTENT_BYTES)
    return yield* fail("DRAFT_TOO_LARGE");

  const config = files.find(({ path }) => path === "skit.json");
  const readme = files.find(({ path }) => path === "README.md");
  const localDescriptor = config
    ? yield* parseSkitConfig(new TextDecoder().decode(config.bytes))
    : readme
      ? yield* parseSkitReadme(new TextDecoder().decode(readme.bytes))
      : yield* fail("DESCRIPTOR_MISSING");
  if (localDescriptor.slug !== slug) return yield* fail("INVALID_DESCRIPTOR_ID");
  const descriptor: RegistryDescriptor = { ...localDescriptor, id: `${owner}/${slug}` };
  const normalizedLocal = yield* normalizeDescriptorDeclarations(descriptor);
  const normalizedInput = yield* normalizeDescriptorDeclarations(descriptorInput);
  if (canonical(normalizedLocal) !== canonical(normalizedInput))
    return yield* fail("DESCRIPTOR_CONTENT_MISMATCH");

  const paths = new Set(files.map(({ path }) => path));
  const text = new TextDecoder();
  const diagnostics: Array<ValidationDiagnostic> = [];
  for (const skill of descriptor.skills) {
    const primary = `${skill.path}/SKILL.md`;
    const primaryFile = files.find(({ path }) => path === primary);
    if (!primaryFile) return yield* fail("SKILL_FILE_MISSING", primary);
    for (const mapping of skill.shared ?? []) {
      if (!files.some(({ path }) => path === mapping.from || path.startsWith(`${mapping.from}/`)))
        return yield* fail("SHARED_SOURCE_MISSING", mapping.from);
    }
    yield* projectSkillFiles(files, skill.path, skill.shared);
    yield* hashProjectedSkillFiles(files, skill.path, skill.shared);
    const reasons = publicationBlockReasons(
      text.decode(primaryFile.bytes),
      skill.capabilities ?? [],
    );
    if (reasons.length > 0)
      diagnostics.push({
        code: "SECURITY_POLICY_BLOCKED",
        severity: "error",
        path: primary,
        message: `Security publication policy blocked: ${reasons.join(", ")}`,
      });
  }

  const contents = new Map(files.map((file) => [file.path, text.decode(file.bytes)]));
  for (const issue of yield* assessInvocationConformance(descriptor.skills, (path) =>
    contents.get(path),
  ))
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
