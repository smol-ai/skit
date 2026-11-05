import { Effect, FileSystem, Option, Schema } from "effect";
import { HttpClient, HttpClientError } from "effect/http";
import { dirname, join, resolve } from "node:path";
import { deterministicTreeHash } from "../artifact/skit.js";
import { inspectNormalizedTree, walkTree } from "../artifact/tree.js";
import { inspectOwnershipMarker } from "../installed-skills/files.js";
import { leavePnpmSkill } from "../installed-skills/pnpm-skills.js";
import { resolveSkitSource } from "../sources/resolve.js";
import { Hash as HashSchema } from "../shared/hash.js";
import { HarnessName } from "../harnesses/contracts.js";
import { InstallScope } from "./scope.js";
import type { SkitSource } from "./library-contracts.js";
import { libraryStateRevision, type LibraryState } from "./library-state.js";
import { inspectResolvedSource, leaveResolvedPnpmSkills } from "./source-inspection.js";

// Whether an existing copy can be managed exactly as it is: its folder holds one Skill whose
// bytes SKIT can retain losslessly, and each target either takes it or already is it.

/** A local folder resolves without the network; any request it made would be refused. */
const offline = HttpClient.make((request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request,
        description: "A local Source is resolved without the network",
      }),
    }),
  ),
);

/** What a local Source would import. Retains nothing. */
const inspectLocalSource = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const parsed: SkitSource = { type: "local", path };
      yield* leavePnpmSkill(path);
      const resolved = yield* resolveSkitSource(parsed);
      yield* leaveResolvedPnpmSkills(parsed, resolved);
      return yield* inspectResolvedSource(parsed, resolved);
    }),
  ).pipe(Effect.provideService(HttpClient.HttpClient, offline));

export const ManageTarget = Schema.Struct({
  path: Schema.String,
  harness: HarnessName,
  scope: InstallScope,
});
export interface ManageTarget extends Schema.Schema.Type<typeof ManageTarget> {}

const ManageBlocker = Schema.Literals([
  "empty-selection",
  "multiple-skills",
  "not-projection-target",
  "content-mismatch",
  "invalid-marker",
  "managed-by-another-entry",
  "would-discard-control-entry",
  "would-normalize-path",
]);
export type ManageBlocker = typeof ManageBlocker.Type;

const PlannedManageTarget = Schema.Union([
  Schema.Struct({
    ...ManageTarget.fields,
    status: Schema.Literal("adoptable"),
    currentHash: HashSchema,
  }),
  Schema.Struct({
    ...ManageTarget.fields,
    status: Schema.Literal("already-managed"),
    currentHash: HashSchema,
  }),
  Schema.Struct({
    ...ManageTarget.fields,
    status: Schema.Literal("blocked"),
    currentHash: Schema.optionalKey(HashSchema),
  }),
]);
export type PlannedManageTarget = typeof PlannedManageTarget.Type;

const ManagePlan = Schema.Struct({
  revision: Schema.String,
  sourcePath: Schema.optionalKey(Schema.String),
  snapshotDigest: Schema.optionalKey(HashSchema),
  skill: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      validationHash: HashSchema,
    }),
  ),
  targets: Schema.Array(PlannedManageTarget),
  blockers: Schema.Array(Schema.Struct({ path: Schema.String, reason: ManageBlocker })),
  applicable: Schema.Boolean,
});
export interface ManagePlan extends Schema.Schema.Type<typeof ManagePlan> {}

const manageBlockers = Effect.fn("Library.manageBlockers")(function* (root: string) {
  const normalized = yield* inspectNormalizedTree(root);
  const verbatim = yield* walkTree(root, "verbatim");
  const blockers: Array<{ path: string; reason: ManageBlocker }> = normalized.excluded
    .filter(
      (entry) =>
        entry.reason === "normalized-control-exclusion" &&
        entry.path.split("/").at(-1) !== ".DS_Store",
    )
    .map((entry) => ({
      path: join(root, entry.path),
      reason: "would-discard-control-entry" as const,
    }));

  for (const entry of verbatim) {
    if (entry.path !== entry.path.normalize("NFC"))
      blockers.push({ path: join(root, entry.path), reason: "would-normalize-path" });
  }

  return { blockers, contentHash: yield* deterministicTreeHash(root) };
});

/** Plan exact-content managing without retaining, projecting, or saving state. */
export const planManage = Effect.fn("Library.planManage")(function* (
  selected: readonly ManageTarget[],
  nominatedSourcePath: string | undefined,
  options: { readonly base: LibraryState },
) {
  const fs = yield* FileSystem.FileSystem;
  const state = options.base;
  const revision = libraryStateRevision(state);
  if (!selected.length) {
    const plan: ManagePlan = {
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
  const preview = yield* inspectLocalSource(sourcePath);
  const blockers: Array<{ path: string; reason: ManageBlocker }> = [];
  const previewSkill = preview.skills.length === 1 ? preview.skills[0] : undefined;
  const sourceContentHash = yield* deterministicTreeHash(sourcePath);
  const existingImportIds = new Set(
    state.imports
      .filter(
        (sourceImport) =>
          sourceImport.source_identity.kind === "local" &&
          resolve(sourceImport.source_identity.path.value) === sourcePath,
      )
      .map((sourceImport) => sourceImport.import_id),
  );
  const existingCollection = state.collections.find((collection) =>
    state.imports.some(
      (sourceImport) =>
        sourceImport.collection_id === collection.collection_id &&
        existingImportIds.has(sourceImport.import_id),
    ),
  );
  const existingSkill = state.skills.find(
    (candidate) =>
      candidate.collection_id === existingCollection?.collection_id &&
      candidate.name === previewSkill?.name,
  );
  const skill = previewSkill
    ? {
        name: previewSkill.name,
        ...(existingSkill === undefined ? {} : { skillId: existingSkill.skill_id }),
        validationHash: sourceContentHash,
      }
    : undefined;
  if (!skill) blockers.push({ path: sourcePath, reason: "multiple-skills" });

  const plannedTargets: PlannedManageTarget[] = [];
  for (const target of targets) {
    const path = resolve(target.path);
    const expectedPath = resolve(join(dirname(path), previewSkill?.name ?? ""));
    const physicalExpectedPath = expectedPath
      ? yield* fs.realPath(expectedPath).pipe(Effect.orElseSucceed(() => expectedPath))
      : undefined;
    const physicalTargetPath = yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => path));
    if (!skill || !physicalExpectedPath || physicalExpectedPath !== physicalTargetPath) {
      blockers.push({ path, reason: "not-projection-target" });
      plannedTargets.push({ ...target, path, status: "blocked" });
      continue;
    }
    const lossless = yield* manageBlockers(path);
    const currentHash = lossless.contentHash;
    let blocked = false;
    if (currentHash !== skill.validationHash) {
      blockers.push({ path, reason: "content-mismatch" });
      blocked = true;
    }
    const marker = yield* inspectOwnershipMarker(path);
    const alreadyManaged =
      marker.kind === "valid" &&
      skill.skillId !== undefined &&
      marker.marker.skill_id === skill.skillId &&
      marker.marker.expected_hash === currentHash;
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
    plannedTargets.push({
      ...target,
      path,
      currentHash,
      status: blocked ? "blocked" : alreadyManaged ? "already-managed" : "adoptable",
    });
  }

  const plan: ManagePlan = {
    revision,
    sourcePath,
    snapshotDigest: preview.snapshot_digest,
    ...(skill ? { skill } : {}),
    targets: plannedTargets,
    blockers,
    applicable: blockers.length === 0,
  };
  return plan;
});

/**
 * Managing keeps a copy whose enable reached only some destinations, warning about the rest; any
 * other incomplete enable stops it.
 */
export const incompleteManageWarning = (
  name: string,
  incomplete: { readonly reason: "destinations" | "update"; readonly message: string },
) =>
  incomplete.reason === "destinations"
    ? Option.some({ name, message: incomplete.message })
    : Option.none<{ readonly name: string; readonly message: string }>();
