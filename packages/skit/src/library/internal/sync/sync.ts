import { Revision, snapshotOf, type Snapshot } from "../../snapshot.js";
import { Effect, Option, Schema, type SchemaIssue } from "effect";
import { isPlatformError } from "effect/PlatformError";
import { Hash, sha256Hash } from "../../../shared/hash.js";
import { type InstallScope } from "../../scope.js";
import { canonicalJson } from "../../../shared/json.js";

import { FailureTypeId } from "../../../shared/failure.js";
import { InvalidLibraryState, LibraryChanged } from "../../failures.js";
import { HomeBusy } from "../../../platform/lock-failures.js";
import { TreeError } from "../../../shared/tree-error.js";
import { InstalledSkills } from "../../installed-skills.js";
import { InvalidIntent } from "../../enabled-plan.js";
import { StalePlan } from "../../library-plan.js";
import {
  LibraryManifest,
  currentLibraryManifest,
  enabledSkillIds,
} from "../../library-contracts.js";
import {
  LibraryState,
  emptyLibraryState,
  libraryManifestFromLocalState,
  SyncAncestry,
} from "../../library-state.js";
import { DeviceSkillSelection } from "../../device-state.js";
import { makeOperationId, OperationId, CollectionVersionId } from "../../entity-ids.js";

import { applyReviewed } from "../../reviewed-plan.js";
import {
  StepRouting,
  SyncFolder,
  SyncPublication,
  SetupStopReason,
  type SyncProgram,
} from "../../store/state-schema.js";
import { setupOperation } from "../../setup.js";
import { planIntent } from "../../plan-changes.js";
import { prepareDeviceInstallation, withDeviceSkillSelection } from "../../enabled.js";
import {
  existingRepositorySkillsDirectory,
  type InventoryRootOptions,
} from "../../routing/roots.js";
import { readableSkillsDirectories } from "../../routing/duplicates.js";
import { routedInstalledSkills } from "../../routing/recorded.js";
import { normalizeLibraryManifest } from "../../manifest.js";
import { blendRestoredState, RestoreInvalid } from "../content/restore.js";
import { inspectContent } from "../content/content.js";
import { alignLibrary, aliasDevice } from "./alignment.js";
import { resolveSyncInstalledSkillCollisions } from "./collisions.js";
import { previewSyncInstalledSkills, SyncInstalledSkillsPreview } from "./installed-skills.js";
import { SyncConflictDetail } from "./conflict.js";
import { syncPublication } from "./operation.js";

const Staged = Schema.Struct({
  manifestDigest: Hash,
  reusable: Schema.Array(Hash),
  retained: Schema.Array(Hash),
  missing: Schema.Array(CollectionVersionId),
  state: Schema.Unknown.pipe(Schema.refine(Schema.is(LibraryState))),
});
export const SyncIntent = Schema.TaggedStruct("Sync", {
  deviceSelection: Schema.OptionFromOptionalKey(DeviceSkillSelection),
  pendingOrigin: Schema.OptionFromOptionalKey(Schema.String),
  acceptedBase: Schema.OptionFromOptionalKey(SyncAncestry),
  remote: Schema.OptionFromOptionalKey(
    Schema.Struct({
      origin: Schema.String,
      libraryId: Schema.OptionFromOptionalKey(Schema.String),
    }),
  ),
  staged: Staged,
});
export type SyncIntent = typeof SyncIntent.Type;
const Remote = Schema.TaggedUnion({
  None: {},
  Expected: {
    origin: Schema.String,
    libraryId: Schema.OptionFromOptionalKey(Schema.String),
    manifestDigest: Hash,
  },
});
const syncPlan = Schema.TaggedStruct("Sync", {
  intent: SyncIntent,
  baseRevision: Revision,
  planId: Hash,
  operationId: OperationId,
  home: Schema.String,
  routing: StepRouting,
  folders: Schema.Array(SyncFolder),
  next: SyncPublication,
  installationIssues: Schema.Array(Schema.String),
  change: Schema.Struct({
    device: Schema.Unknown.pipe(Schema.refine(Schema.is(LibraryState))),
    deviceSelection: Schema.OptionFromOptionalKey(DeviceSkillSelection),
    installedSkills: Schema.OptionFromOptionalKey(SyncInstalledSkillsPreview),
    collectionsToRemove: Schema.Number,
    missingSelection: Schema.Array(Schema.String),
    collisions: Schema.Array(SyncConflictDetail),
    clean: Schema.Boolean,
    acceptedBase: Schema.OptionFromOptionalKey(SyncAncestry),
    remote: Remote,
    staged: Staged,
  }),
});
const localSyncPlan = syncPlan.mapFields((fields) => ({
  ...fields,
  change: fields.change.mapFields((change) => ({ ...change, remote: Remote.cases.None })),
}));
const remoteSyncPlan = syncPlan.mapFields((fields) => ({
  ...fields,
  change: fields.change.mapFields((change) => ({ ...change, remote: Remote.cases.Expected })),
}));
export type LocalSyncPlan = typeof localSyncPlan.Type;
export type RemoteSyncPlan = typeof remoteSyncPlan.Type;
export type SyncPlan = LocalSyncPlan | RemoteSyncPlan;
export const SyncPlan = Schema.Union([localSyncPlan, remoteSyncPlan]);
export type StoredSyncPlan = typeof SyncPlan.Encoded;
export const isRemoteSyncPlan = (plan: SyncPlan): plan is RemoteSyncPlan =>
  plan.change.remote._tag === "Expected";
export const RemoteReceipt = Schema.Struct({
  origin: Schema.String,
  libraryId: Schema.String,
  manifestDigest: Hash,
  revisionId: Schema.String,
  ancestry: SyncAncestry,
});
export type RemoteReceipt = typeof RemoteReceipt.Type;
export type SyncApplyRequest =
  | { readonly _tag: "Apply"; readonly plan: LocalSyncPlan; readonly receipt?: never }
  | {
      readonly _tag: "ApplySynced";
      readonly plan: RemoteSyncPlan;
      readonly receipt: RemoteReceipt;
    };
export interface SyncResult {
  readonly installed: number;
  readonly uninstalled: number;
  readonly enablementIssues: readonly string[];
  readonly ancestry: Option.Option<SyncAncestry>;
}
export interface SyncOutcome {
  readonly _tag: "Sync";
  readonly result: SyncResult;
}
export class SyncStopped extends Schema.TaggedError<SyncStopped>()("Library.SyncStopped", {
  operationId: OperationId,
  reason: SetupStopReason,
}) {
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT";
  readonly remediation =
    "Inspect Library history and retry Sync after resolving the reported change.";
  get message() {
    return `Local Sync stopped at its recorded operation ${this.operationId}`;
  }
}

const digest = (value: unknown) => sha256Hash(new TextEncoder().encode(canonicalJson(value)));
const normalized = (manifest: LibraryManifest) => normalizeLibraryManifest(manifest);
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const emptyManifest = currentLibraryManifest({
  collections: [],
  skills: [],
  collection_versions: [],
  imports: [],
  enabled: [],
  snapshot_digests: [],
});

/** Global destinations come from this owner; repositories keep their already-recorded routes. */
const routingFor = Effect.fn("Library.sync.routing")(function* (
  state: LibraryState,
  options: { readonly none?: boolean; readonly roots?: InventoryRootOptions },
) {
  if (options.none) return { active: [], destinations: [], readable: [] } satisfies StepRouting;
  const files = yield* InstalledSkills.Service;
  const active = yield* files.active;
  const globals = yield* files.destinations({ kind: "global" });
  const scopes: InstallScope[] = [
    { kind: "global" },
    ...state.repositories.map(({ root }) => ({ kind: "repository" as const, root })),
  ];
  const roots = options.roots;
  return {
    active,
    destinations: scopes.flatMap<StepRouting["destinations"][number]>((scope) =>
      scope.kind === "global"
        ? globals.map((destination) => ({ scope, ...destination }))
        : active.flatMap((destination) => {
            const root = existingRepositorySkillsDirectory(state, scope.root, destination);
            return root === undefined ? [] : [{ scope, destination, root }];
          }),
    ),
    readable:
      roots === undefined
        ? []
        : scopes.flatMap((scope) =>
            readableSkillsDirectories(roots, scope).map((root) => ({ scope, ...root })),
          ),
  } satisfies StepRouting;
});

/** Plan only the local half; callers retain remote merge, upload and compare-and-swap. */
export const planSync = Effect.fn("Library.planSync")(function* (
  home: string,
  input: SyncIntent,
  options: {
    readonly base: Snapshot;
    readonly none?: boolean;
    readonly roots?: InventoryRootOptions;
    readonly operationId?: OperationId;
  },
) {
  const intent = yield* Schema.encodeEffect(SyncIntent)(input).pipe(
    Effect.map((encoded) => structuredClone(encoded)),
    Effect.flatMap(Schema.decodeUnknownEffect(SyncIntent)),
    Effect.mapError(() => new InvalidIntent({ detail: "Invalid Sync intent" })),
  );
  if (intent.staged.missing.length)
    return yield* new RestoreInvalid({
      detail: `retained copies unavailable: ${intent.staged.missing.join(", ")}`,
    });
  const manifestOf = (state: LibraryState) =>
    libraryManifestFromLocalState(state).pipe(
      Effect.mapError(
        () =>
          new InvalidLibraryState({ path: `${home}/state.json`, detail: "Invalid Sync manifest" }),
      ),
    );
  const manifest = normalized(yield* manifestOf(intent.staged.state));
  if ((yield* digest(manifest)) !== intent.staged.manifestDigest)
    return yield* new StalePlan({ message: "The staged Sync manifest changed" });
  const state =
    options.base._tag === "Present" ? structuredClone(options.base.state) : emptyLibraryState();
  const local = yield* manifestOf(state);
  if (!same(state.sync_ancestry ?? null, Option.getOrUndefined(intent.acceptedBase) ?? null))
    return yield* new StalePlan({ message: "The accepted Sync base changed" });
  const prior = Option.getOrUndefined(intent.acceptedBase);
  const remote = Option.getOrUndefined(intent.remote);
  const alignmentBase =
    prior !== undefined &&
    remote !== undefined &&
    remote.origin === prior.origin &&
    Option.getOrUndefined(remote.libraryId) === prior.library_id
      ? prior.base_manifest
      : emptyManifest;
  const aliases = alignLibrary(local, manifest, alignmentBase);
  const aligned = yield* LibraryState.makeEffect(aliasDevice(state, aliases)).pipe(
    Effect.mapError(
      () =>
        new InvalidIntent({ detail: "The Sync target cannot preserve this device's references" }),
    ),
  );
  const device = withDeviceSkillSelection(
    aligned,
    Option.getOrUndefined(intent.deviceSelection),
    Option.getOrUndefined(intent.pendingOrigin),
  );
  const routing = yield* routingFor(device, options);
  const rootFor = (destination: "agents" | "claude") =>
    routing.destinations.find(
      (item) => item.scope.kind === "global" && item.destination === destination,
    )?.root;
  const installation = prepareDeviceInstallation(device, manifest);
  const collisions = yield* resolveSyncInstalledSkillCollisions(
    installation.manifest,
    rootFor,
    [],
    device,
  ).pipe(Effect.mapError(() => new InvalidIntent({ detail: "Invalid Sync collision choices" })));
  const installedSkills =
    options.base._tag === "Absent"
      ? Option.none()
      : Option.some(
          yield* previewSyncInstalledSkills(
            state,
            device,
            installation.manifest,
            rootFor,
            installation.independent,
          ).pipe(
            Effect.mapError(() => new InvalidIntent({ detail: "Invalid installed Sync preview" })),
          ),
        );
  const conflicts = [
    ...collisions.conflicts,
    ...(Option.getOrUndefined(installedSkills)?.conflicts ?? []),
  ];
  const missingSelection = installation.missing.map(
    (item) =>
      `The selected ${"skill" in item ? `skill ${item.skill}` : `collection ${item.collection}`} is no longer in the Library; update this device's selection.`,
  );
  const issues = installation.independent
    ? [
        ...missingSelection,
        ...conflicts.map((item) => item.message),
        ...(Option.getOrUndefined(installedSkills)?.issues.map((item) => item.message) ?? []),
      ]
    : [];
  if (installation.independent) {
    const names = manifest.skills
      .filter((skill) =>
        enabledSkillIds(manifest, installation.manifest.enabled).includes(skill.skill_id),
      )
      .map((skill) => skill.name);
    if (names.length) {
      const inspected = yield* Effect.result(
        (yield* InstalledSkills.Service).duplicates.scan({ kind: "global" }, names),
      );
      if (inspected._tag === "Failure")
        issues.push(`Could not inspect existing Skill installations: ${String(inspected.failure)}`);
      else
        for (const duplicate of inspected.success.copies)
          issues.push(
            `${duplicate.name} already exists at ${duplicate.aliases.map((alias) => (alias.linkPath === undefined ? alias.path : `${alias.path} (symlink ${alias.linkPath} → ${alias.linkTarget})`)).join(", ")} (resolved: ${duplicate.canonicalPath}); review it before enabling.`,
          );
    }
  }
  const next = yield* blendRestoredState(
    {
      ...device,
      installed_skills: [...(Option.getOrUndefined(installedSkills)?.projections ?? [])],
    },
    intent.staged.state,
  );
  const files = yield* routedInstalledSkills(routing);
  const paths = new Set(state.installed_skills.map((copy) => copy.path));
  const inspected = yield* Effect.result(
    planIntent({ _tag: "Update" }, { home, base: snapshotOf({ present: true, state: next }) }).pipe(
      Effect.provideService(InstalledSkills.Service, files),
    ),
  );
  if (inspected._tag === "Success")
    for (const folder of inspected.success.folders) paths.add(folder.path);
  else if (!installation.independent && conflicts.length === 0)
    return yield* Effect.fail(inspected.failure);
  const folders = yield* Effect.forEach([...paths], (path) =>
    Effect.map(files.inspect(path), (folder) => ({
      path,
      entry: folder.entry._tag === "Absent" ? ("Absent" as const) : folder.entry.kind,
      evidence: folder.evidence,
      ancestors: folder.ancestors,
    })),
  );
  const data = {
    _tag: "Sync" as const,
    intent,
    baseRevision: options.base.revision,
    operationId: options.operationId ?? makeOperationId(),
    home,
    routing,
    folders,
    next: syncPublication(next),
    installationIssues: issues,
    change: {
      device,
      deviceSelection: intent.deviceSelection,
      installedSkills,
      collectionsToRemove: state.collections.filter(
        (collection) =>
          !manifest.collections.some((item) => item.collection_id === collection.collection_id),
      ).length,
      missingSelection,
      collisions: conflicts,
      clean: same(normalized(local), manifest),
      acceptedBase: intent.acceptedBase,
      remote: Option.match(intent.remote, {
        onNone: () => ({ _tag: "None" as const }),
        onSome: (remote) => ({
          _tag: "Expected" as const,
          ...remote,
          manifestDigest: intent.staged.manifestDigest,
        }),
      }),
      staged: intent.staged,
    },
  };
  const planId = yield* digest(data);
  const reviewed: Effect.Effect<SyncPlan, SchemaIssue.Issue> =
    data.change.remote._tag === "None"
      ? localSyncPlan.makeEffect({
          ...data,
          planId,
          change: { ...data.change, remote: data.change.remote },
        })
      : remoteSyncPlan.makeEffect({
          ...data,
          planId,
          change: { ...data.change, remote: data.change.remote },
        });
  return yield* reviewed.pipe(
    Effect.mapError(() => new InvalidIntent({ detail: "Invalid local Sync plan" })),
  );
});

/** Verify the receipt and exact review before recording a replayable local program. */
export const applySync = Effect.fn("Library.applySync")(function* (
  home: string,
  request: SyncApplyRequest,
  options: { readonly none?: boolean; readonly roots?: InventoryRootOptions },
) {
  const approved = request.plan;
  if (approved.home !== home)
    return yield* new StalePlan({ message: "The Sync plan belongs to another Library" });
  let ancestry = Option.getOrUndefined(approved.intent.acceptedBase);
  if (approved.change.remote._tag === "Expected") {
    if (request._tag !== "ApplySynced")
      return yield* new StalePlan({ message: "This Sync plan requires its remote receipt" });
    const receipt = request.receipt;
    const remote = approved.change.remote;
    if (
      receipt.origin !== remote.origin ||
      receipt.manifestDigest !== remote.manifestDigest ||
      (Option.isSome(remote.libraryId) && remote.libraryId.value !== receipt.libraryId) ||
      receipt.ancestry.origin !== receipt.origin ||
      receipt.ancestry.library_id !== receipt.libraryId ||
      receipt.ancestry.revision_id !== receipt.revisionId ||
      (yield* digest(normalized(receipt.ancestry.base_manifest))) !== remote.manifestDigest
    )
      return yield* new StalePlan({
        message: "The remote receipt does not match the reviewed Sync plan",
      });
    ancestry = receipt.ancestry;
  } else if (request._tag !== "Apply")
    return yield* new StalePlan({ message: "This local Sync plan cannot accept a remote receipt" });
  return yield* applyReviewed(
    home,
    approved,
    (base) =>
      planSync(home, approved.intent, { ...options, base, operationId: approved.operationId }),
    (fresh, base) =>
      Effect.gen(function* () {
        if (
          fresh.change.collisions.length &&
          fresh.change.device.device_skill_selection?.mode !== "choose"
        )
          return yield* new InvalidIntent({
            detail: fresh.change.collisions.map((item) => item.message).join("; "),
          });
        const current = base._tag === "Present" ? base.state : emptyLibraryState();
        const inspected = yield* inspectContent(
          home,
          snapshotOf({ present: true, state: fresh.intent.staged.state }),
        );
        if (inspected._tag === "Changed")
          return yield* new RestoreInvalid({
            detail: `Retained Sync content changed: ${inspected.hash}`,
          });
        const keepCurrent =
          fresh.change.clean &&
          same(current.sync_ancestry ?? null, ancestry ?? null) &&
          same(current.device_skill_selection ?? null, fresh.next.device_skill_selection ?? null);
        const next = {
          ...(keepCurrent
            ? { ...syncPublication(current), installed_skills: fresh.next.installed_skills }
            : fresh.next),
          ...(ancestry === undefined ? {} : { sync_ancestry: ancestry }),
        };
        const files = yield* routedInstalledSkills(fresh.routing);
        const update = yield* Effect.result(
          planIntent(
            { _tag: "Update" },
            {
              home,
              base: snapshotOf({
                present: true,
                state: { ...next, operations: current.operations },
              }),
            },
          ).pipe(Effect.provideService(InstalledSkills.Service, files)),
        );
        const work =
          update._tag === "Failure" ||
          update.success.changes.some(
            (change) => change._tag !== "Unchanged" && change._tag !== "Protected",
          );
        const sameMetadata = same(
          { ...syncPublication(current), installed_skills: [] },
          { ...next, installed_skills: [] },
        );
        const preview = Option.getOrUndefined(fresh.change.installedSkills);
        const retirement = (preview?.retire.length ?? 0) > 0 || (preview?.remove.length ?? 0) > 0;
        if (sameMetadata && !work && !retirement)
          return {
            _tag: "Sync" as const,
            result: {
              installed: 0,
              uninstalled: 0,
              enablementIssues: fresh.installationIssues,
              ancestry: Option.fromUndefinedOr(ancestry),
            },
          } satisfies SyncOutcome;
        const program: SyncProgram = {
          before: syncPublication(current),
          after: next,
          routing: fresh.routing,
          retire: current.installed_skills.filter((copy) =>
            preview?.retire.includes(copy.installed_skill_id),
          ),
          drop: preview?.remove ?? [],
          manifestDigest: fresh.intent.staged.manifestDigest,
          receipt:
            request._tag === "ApplySynced" ? Option.some(request.receipt.ancestry) : Option.none(),
          folders: fresh.folders,
          issues: fresh.installationIssues,
        };
        const result = yield* setupOperation(
          [
            { _tag: "Sync", phase: "retire", program },
            { _tag: "Sync", phase: "publish", sourceStep: 0 },
            { _tag: "Sync", phase: "install", sourceStep: 0 },
          ],
          { base, operationId: fresh.operationId, replaceDone: false },
        );
        if (result._tag === "Stopped") {
          if (result.reason._tag === "StepFailed") {
            const error = result.reason.error;
            if (
              Schema.is(InvalidLibraryState)(error) ||
              Schema.is(HomeBusy)(error) ||
              Schema.is(LibraryChanged)(error) ||
              Schema.is(TreeError)(error) ||
              isPlatformError(error)
            )
              return yield* Effect.fail(error);
          }
          return yield* new SyncStopped({ operationId: fresh.operationId, reason: result.reason });
        }
        const done = result.steps.filter((step) => step._tag === "Sync");
        return {
          _tag: "Sync" as const,
          result: {
            installed: done.reduce((n, step) => n + step.installed, 0),
            uninstalled: done.reduce((n, step) => n + step.uninstalled, 0),
            enablementIssues:
              done.find((step) => step.phase === "install")?.issues ?? fresh.installationIssues,
            ancestry: Option.fromUndefinedOr(ancestry),
          },
        } satisfies SyncOutcome;
      }),
  );
});
export type SyncPlanError = Effect.Error<ReturnType<typeof planSync>>;
export type SyncApplyError = Effect.Error<ReturnType<typeof applySync>>;
