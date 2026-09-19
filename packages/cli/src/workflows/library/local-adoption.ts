import {
  canonicalJson,
  collectionRef,
  deterministicTreeHashEffect,
  Digest as DigestSchema,
  HarnessName,
  inspectNormalizedTreeEffect,
  inspectOwnershipMarkerEffect,
  LibraryStore,
  SkitBindingScope,
  walkTreeEffect,
} from "@smolai/skit-core";
import { Effect, FileSystem, Schema } from "effect";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { inspectPortableLibrarySourceEffect } from "./portable-add.js";
import type { ProjectionOptions } from "./projection-options.js";
import type { RetentionOptions } from "./retention-options.js";

export const LocalAdoptionTarget = Schema.Struct({
  path: Schema.String,
  harness: HarnessName,
  scope: SkitBindingScope,
});
export interface LocalAdoptionTarget extends Schema.Schema.Type<typeof LocalAdoptionTarget> {}

export const LocalAdoptionBlockerReason = Schema.Literals([
  "empty-selection",
  "multiple-skills",
  "not-projection-target",
  "content-mismatch",
  "invalid-marker",
  "managed-by-another-entry",
  "would-discard-control-entry",
  "would-discard-empty-directory",
  "would-normalize-path",
]);
export type LocalAdoptionBlockerReason = typeof LocalAdoptionBlockerReason.Type;

export const LocalAdoptionPlannedTarget = Schema.Union([
  Schema.Struct({
    ...LocalAdoptionTarget.fields,
    status: Schema.Literal("adoptable"),
    observedHash: DigestSchema,
  }),
  Schema.Struct({
    ...LocalAdoptionTarget.fields,
    status: Schema.Literal("already-managed"),
    observedHash: DigestSchema,
  }),
  Schema.Struct({
    ...LocalAdoptionTarget.fields,
    status: Schema.Literal("blocked"),
    observedHash: Schema.optionalKey(DigestSchema),
  }),
]);
export type LocalAdoptionPlannedTarget = typeof LocalAdoptionPlannedTarget.Type;

export const LocalAdoptionPlan = Schema.Struct({
  revision: Schema.String,
  sourcePath: Schema.optionalKey(Schema.String),
  sourceIdentityRef: Schema.optionalKey(Schema.String),
  snapshotDigest: Schema.optionalKey(DigestSchema),
  skill: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      markerSkillRef: Schema.String,
      validationDigest: DigestSchema,
    }),
  ),
  targets: Schema.Array(LocalAdoptionPlannedTarget),
  blockers: Schema.Array(
    Schema.Struct({ path: Schema.String, reason: LocalAdoptionBlockerReason }),
  ),
  applicable: Schema.Boolean,
});
export interface LocalAdoptionPlan extends Schema.Schema.Type<typeof LocalAdoptionPlan> {}

export interface LocalAdoptionOptions {
  readonly acquisition: RetentionOptions;
  readonly bindings: ProjectionOptions;
}

const losslessAdoptionBlockers = Effect.fn("Library.inspectLosslessAdoption")(function* (
  root: string,
) {
  const normalized = yield* inspectNormalizedTreeEffect(root);
  const verbatim = yield* walkTreeEffect(root, "verbatim");
  const blockers: Array<{ path: string; reason: LocalAdoptionBlockerReason }> = normalized.excluded
    .filter((entry) => entry.reason === "normalized-control-exclusion")
    .map((entry) => ({
      path: join(root, entry.path),
      reason: "would-discard-control-entry" as const,
    }));

  for (const entry of verbatim) {
    if (entry.path !== entry.path.normalize("NFC"))
      blockers.push({ path: join(root, entry.path), reason: "would-normalize-path" });
    if (
      entry.kind === "directory" &&
      !verbatim.some((candidate) => candidate.path.startsWith(`${entry.path}/`))
    )
      blockers.push({
        path: join(root, entry.path),
        reason: "would-discard-empty-directory",
      });
  }

  return { blockers, contentHash: yield* deterministicTreeHashEffect(root) };
});

/** Plan exact-content Custody transfer without retaining, projecting, or publishing state. */
export const planLocalAdoption = Effect.fn("Library.planLocalAdoption")(function* (
  options: LocalAdoptionOptions,
  selected: readonly LocalAdoptionTarget[],
  nominatedSourcePath?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* (yield* LibraryStore).load;
  const revision = createHash("sha256").update(canonicalJson(state)).digest("hex");
  if (!selected.length) {
    const plan: LocalAdoptionPlan = {
      revision,
      targets: [],
      blockers: [{ path: "", reason: "empty-selection" }],
      applicable: false,
    };
    return plan;
  }

  const targets = [...selected].sort((left, right) =>
    resolve(left.path).localeCompare(resolve(right.path)),
  );
  const sourcePath = resolve(nominatedSourcePath ?? selected[0]!.path);
  const preview = yield* inspectPortableLibrarySourceEffect({}, sourcePath);
  const blockers: Array<{ path: string; reason: LocalAdoptionBlockerReason }> = [];
  const previewSkill = preview.skills.length === 1 ? preview.skills[0] : undefined;
  const sourceContentHash = yield* deterministicTreeHashEffect(sourcePath);
  const ref = collectionRef(preview.identity);
  const existingAcquisitionIds = new Set(
    state.acquisitions
      .filter(
        (acquisition) =>
          acquisition.source_identity.kind === "local" &&
          resolve(acquisition.source_identity.path.value) === sourcePath,
      )
      .map((acquisition) => acquisition.acquisition_id),
  );
  const existingCollection = state.collections.find((collection) =>
    state.skills.some(
      (candidate) =>
        candidate.collection_id === collection.collection_id &&
        candidate.versions.some((version) =>
          version.origins.some((origin) => existingAcquisitionIds.has(origin.acquisition_id)),
        ),
    ),
  );
  const markerCollectionRef = existingCollection?.collection_id ?? ref;
  const existingSkill = state.skills.find(
    (candidate) =>
      candidate.collection_id === existingCollection?.collection_id &&
      candidate.name === previewSkill?.name,
  );
  const skill = previewSkill
    ? {
        name: previewSkill.name,
        markerSkillRef: `${markerCollectionRef}#${encodeURIComponent(previewSkill.name)}`,
        ...(existingSkill === undefined ? {} : { skillId: existingSkill.skill_id }),
        validationDigest: sourceContentHash,
      }
    : undefined;
  if (!skill) blockers.push({ path: sourcePath, reason: "multiple-skills" });

  const observedTargets: LocalAdoptionPlannedTarget[] = [];
  for (const target of targets) {
    const path = resolve(target.path);
    const expectedPath = resolve(join(dirname(path), previewSkill?.name ?? ""));
    const physicalExpectedPath = expectedPath
      ? yield* fs.realPath(expectedPath).pipe(Effect.orElseSucceed(() => expectedPath))
      : undefined;
    const physicalTargetPath = yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => path));
    if (!skill || !physicalExpectedPath || physicalExpectedPath !== physicalTargetPath) {
      blockers.push({ path, reason: "not-projection-target" });
      observedTargets.push({ ...target, path, status: "blocked" });
      continue;
    }
    const lossless = yield* losslessAdoptionBlockers(path);
    const observedHash = lossless.contentHash;
    let blocked = false;
    if (observedHash !== skill.validationDigest) {
      blockers.push({ path, reason: "content-mismatch" });
      blocked = true;
    }
    const marker = yield* inspectOwnershipMarkerEffect(path);
    const alreadyManaged =
      marker.kind === "valid" &&
      skill.skillId !== undefined &&
      marker.marker.skill_id === skill.skillId &&
      marker.marker.expected_digest === observedHash;
    if (!alreadyManaged && lossless.blockers.length > 0) {
      blockers.push(...lossless.blockers);
      blocked = true;
    }
    if (marker.kind === "invalid") {
      blockers.push({ path, reason: "invalid-marker" });
      blocked = true;
    }
    if (marker.kind === "valid" && !alreadyManaged) {
      blockers.push({ path, reason: "managed-by-another-entry" });
      blocked = true;
    }
    observedTargets.push({
      ...target,
      path,
      observedHash,
      status: blocked ? "blocked" : alreadyManaged ? "already-managed" : "adoptable",
    });
  }

  const plan: LocalAdoptionPlan = {
    revision,
    sourcePath,
    sourceIdentityRef: ref,
    snapshotDigest: preview.snapshot_digest,
    ...(skill ? { skill } : {}),
    targets: observedTargets,
    blockers,
    applicable: blockers.length === 0,
  };
  return plan;
});

export const localAdoptionPlanIdentity = (plan: LocalAdoptionPlan) =>
  createHash("sha256")
    .update(
      canonicalJson({
        revision: plan.revision,
        sourcePath: plan.sourcePath,
        sourceIdentityRef: plan.sourceIdentityRef,
        snapshotDigest: plan.snapshotDigest,
        skill: plan.skill,
        targets: plan.targets,
        blockers: plan.blockers,
        applicable: plan.applicable,
      }),
    )
    .digest("hex");
