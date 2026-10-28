import {
  encodeHashParts,
  normalizeDescriptorDeclarations as normalizeDescriptor,
  installedSkillHashParts,
  projectSkillFiles as projectFiles,
  sha256Hash,
  type SharedMapping,
} from "@smolai/skit-core/universal/consumer";
import { Effect } from "effect";
import { IntegrityError } from "./contracts.js";

interface SharedFailure {
  readonly _tag?: string;
  readonly message?: string;
}

export const descriptorError = (cause: SharedFailure) =>
  new IntegrityError({
    code:
      cause._tag === "ConflictingInvocationDeclaration"
        ? "CONFLICTING_INVOCATION_DECLARATIONS"
        : "INVALID_DESCRIPTOR",
    ...(cause.message ? { detail: cause.message } : {}),
  });

export const normalizeDescriptorDeclarations = Effect.fn(
  "Integrity.normalizeDescriptorDeclarations",
)((value: unknown) =>
  Effect.try({
    try: () => normalizeDescriptor(value),
    catch: (cause) => descriptorError(cause as SharedFailure),
  }),
);

export interface InstalledFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly executable?: boolean;
}

const projectionError = (cause: SharedFailure) =>
  new IntegrityError({
    code:
      cause._tag === "SharedTargetCollision"
        ? "SHARED_MAPPING_COLLISION"
        : "PROJECTED_PATH_COLLISION",
    ...(cause.message ? { detail: cause.message } : {}),
  });

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
