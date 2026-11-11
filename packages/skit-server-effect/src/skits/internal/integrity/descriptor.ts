import { descriptorIssue } from "./descriptor-issue.js";
import {
  DescriptorFailure,
  SharedTargetCollision,
  InstalledPathCollision,
  encodeHashParts,
  normalizeDescriptorDeclarations as normalizeDescriptor,
  installedSkillHashParts,
  projectSkillFiles as projectFiles,
  sha256Hash,
  type SharedMapping,
} from "@smolai/skit-core/universal/consumer";
import { Effect, Match, Schema } from "effect";
import { IntegrityError } from "./contracts.js";

const descriptorFailure = Match.type<DescriptorFailure>().pipe(
  Match.tagsExhaustive({
    DescriptorMalformed: ({ format, issue }) =>
      `Malformed ${format.toUpperCase()} SKIT Descriptor: ${descriptorIssue(issue)}`,
    DuplicateSkillNames: () => "Contained skill names must be unique within a SKIT",
    DuplicateSkillPaths: () => "Contained skill paths must be unique within a SKIT",
    ConflictingInvocationDeclaration: ({ skill }) =>
      `${skill} declares conflicting invocation and trigger_modes values`,
    ReadmeFrontmatterMissing: () => "README.md must begin with YAML frontmatter",
  }),
);

export const descriptorError = (cause: unknown) => {
  if (Schema.is(DescriptorFailure)(cause))
    return new IntegrityError({
      code:
        cause._tag === "ConflictingInvocationDeclaration"
          ? "CONFLICTING_INVOCATION_DECLARATIONS"
          : "INVALID_DESCRIPTOR",
      detail: descriptorFailure(cause),
    });
  return new IntegrityError({
    code: "INVALID_DESCRIPTOR",
    ...(cause instanceof Error && cause.message ? { detail: cause.message } : {}),
  });
};

export const normalizeDescriptorDeclarations = Effect.fn(
  "Integrity.normalizeDescriptorDeclarations",
)((value: unknown) =>
  Effect.try({
    try: () => normalizeDescriptor(value),
    catch: (cause) => descriptorError(cause),
  }),
);

export interface InstalledFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly executable?: boolean;
}

const projectionError = Match.type<SharedTargetCollision | InstalledPathCollision>().pipe(
  Match.tagsExhaustive({
    SharedTargetCollision: ({ target }) =>
      new IntegrityError({
        code: "SHARED_MAPPING_COLLISION",
        detail: `Shared target collision: ${target}`,
      }),
    ProjectedPathCollision: ({ path, kind }) =>
      new IntegrityError({
        code: "PROJECTED_PATH_COLLISION",
        detail:
          kind === "file"
            ? `Installed file collision: ${path}`
            : `Installed file/directory collision: ${path}`,
      }),
  }),
);

export const projectSkillFiles = Effect.fn("Integrity.projectSkillFiles")(function* (
  files: ReadonlyArray<InstalledFile>,
  skillPath: string,
  shared: ReadonlyArray<SharedMapping> = [],
) {
  return yield* Effect.fromResult(projectFiles([...files], skillPath, [...shared])).pipe(
    Effect.mapError(projectionError),
  );
});

export const hashInstalledSkillFiles = Effect.fn("Integrity.hashProjectedSkillFiles")(function* (
  files: ReadonlyArray<InstalledFile>,
  skillPath: string,
  shared: ReadonlyArray<SharedMapping> = [],
) {
  const parts = yield* Effect.fromResult(
    installedSkillHashParts([...files], skillPath, [...shared]),
  ).pipe(Effect.mapError(projectionError));
  return yield* sha256Hash(encodeHashParts(parts));
});
