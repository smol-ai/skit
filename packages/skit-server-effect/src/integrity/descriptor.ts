import {
  canonicalJson,
  normalizeDescriptorDeclarations as normalizeDescriptor,
  parseSkitConfigEffect,
  parseSkitReadmeEffect,
  projectedSkillHashParts,
  projectSkillFiles as projectFiles,
  type SkitDescriptor,
} from "@smolai/skit-core/universal/consumer";
import { Effect } from "effect";
import type { SharedMapping } from "./contracts.js";
import { IntegrityError } from "./contracts.js";
import { encodeHashParts, sha256 } from "./crypto.js";

interface SharedFailure {
  readonly _tag?: string;
  readonly message?: string;
}

const descriptorError = (cause: SharedFailure) =>
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

export const parseSkitReadme = (text: string) =>
  parseSkitReadmeEffect(text).pipe(Effect.mapError(descriptorError));

export const parseSkitConfig = (text: string) =>
  parseSkitConfigEffect(text).pipe(Effect.mapError(descriptorError));

export const canonical = canonicalJson;

export interface ProjectedFile {
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
  files: ReadonlyArray<ProjectedFile>,
  skillPath: string,
  shared: ReadonlyArray<SharedMapping> = [],
) {
  return yield* Effect.try({
    try: () => projectFiles([...files], skillPath, [...shared]),
    catch: (cause) => projectionError(cause as SharedFailure),
  });
});

export const hashProjectedSkillFiles = Effect.fn("Integrity.hashProjectedSkillFiles")(function* (
  files: ReadonlyArray<ProjectedFile>,
  skillPath: string,
  shared: ReadonlyArray<SharedMapping> = [],
) {
  const parts = yield* Effect.try({
    try: () => projectedSkillHashParts([...files], skillPath, [...shared]),
    catch: (cause) => projectionError(cause as SharedFailure),
  });
  return yield* sha256(encodeHashParts(parts));
});

export type { SkitDescriptor };
