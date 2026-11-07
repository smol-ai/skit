import { Data, Effect, Option } from "effect";
import type * as Library from "../../library.js";
import { StalePlan } from "../../library-plan.js";
import { isRemoteSyncPlan } from "./sync.js";
import { currentLibraryManifest, type LibraryManifest } from "../../library-contracts.js";
import { libraryManifestFromLocalState } from "../../library-state.js";
import { normalizeLibraryManifest } from "../../manifest.js";
import { withDeviceSkillSelection, prepareDeviceInstallation } from "../../enabled.js";
import type { Snapshot } from "../../snapshot.js";
import {
  activeInstallDestinations,
  skillsDirectoryFor,
  type InventoryRootOptions,
} from "../../routing/roots.js";
import { canonicalJson } from "../../../shared/json.js";
import { FailureTypeId, type SkitFailure } from "../../../shared/failure.js";
import { OptionCombinationInvalid } from "../../../shared/input-failures.js";
import { prepareLibraryMerge } from "./merge.js";
import { planLibrarySync } from "./plan.js";
import { selectDeviceSkills } from "./device-selection.js";
import { resolveSyncInstalledSkillCollisions } from "./collisions.js";
import { previewSyncInstalledSkills } from "./installed-skills.js";
import type { SyncConflictDetail } from "./conflict.js";
import type { SyncChanges } from "../../sync-changes.js";

export class SyncLocalChanged
  extends Data.TaggedError("Library.SyncLocalChanged")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Sync again.";
  get message(): string {
    return "The local Library changed while sync was running";
  }
}

export interface SyncSessionRequest {
  readonly origin: string;
  readonly remote: {
    readonly library_id: string;
    readonly revision_id: string;
    readonly manifest: LibraryManifest;
  } | null;
  readonly takeRemote?: readonly string[];
  readonly keepEnabled?: readonly string[];
  readonly deviceSelection?:
    | "follow-account"
    | { readonly skills: readonly string[]; readonly collections: readonly string[] };
  readonly around?: <A, E, R>(
    phase: { readonly kind: "merge" | "check-destinations" | "check-installed-skills" },
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}
const empty = currentLibraryManifest({
  collections: [],
  skills: [],
  collection_versions: [],
  imports: [],
  enabled: [],
  snapshot_digests: [],
});
const same = (left: LibraryManifest, right: LibraryManifest) =>
  canonicalJson(normalizeLibraryManifest(left)) === canonicalJson(normalizeLibraryManifest(right));
const conflict = (details: readonly SyncConflictDetail[], revision_id?: string) => ({
  status: "conflicted" as const,
  ...(revision_id === undefined ? {} : { revision_id }),
  conflicts: [...new Set(details.map((item) => item.key))].sort(),
  conflict_details: details,
});

/**
 * Capture a reviewed sync, retaining its base, remote head and device choices inside Library.
 * Transport may stage the returned target and CAS it remotely; only this session constructs the
 * local plan and receipt. Returned facts are copies, so changing a view cannot redirect apply.
 */
export function openSyncSession(
  library: Pick<Library.Interface, "read" | "plan" | "apply" | "content">,
  roots: InventoryRootOptions,
  request: SyncSessionRequest,
  options: { readonly base: Snapshot },
) {
  const snapshot = structuredClone(options.base);
  const { around: report, ...choices } = request;
  const input = structuredClone(choices);
  const around: NonNullable<SyncSessionRequest["around"]> = report ?? ((_phase, work) => work);
  return Effect.gen(function* () {
    const active = yield* activeInstallDestinations(roots);
    const rootFor = (
      target: import("../../../installed-skills/destination.js").InstallDestination,
    ) =>
      active.includes(target) ? skillsDirectoryFor(target, { kind: "global" }, roots) : undefined;
    const remote = input.remote;
    const present = snapshot._tag === "Present";
    const ancestry = present ? snapshot.state.sync_ancestry : undefined;
    const manifest = present ? yield* libraryManifestFromLocalState(snapshot.state) : empty;
    const mismatched =
      ancestry !== undefined &&
      (ancestry.origin !== input.origin ||
        remote === null ||
        ancestry.library_id !== remote.library_id);
    const note = mismatched
      ? { merge_base: "empty-different-library" as const }
      : ancestry === undefined && present && remote !== null
        ? { merge_base: "empty-first-sync" as const }
        : {};
    if (!present && remote === null)
      return {
        _tag: "Empty" as const,
        apply: Effect.gen(function* () {
          if (input.deviceSelection === undefined) return;
          const selection =
            input.deviceSelection === "follow-account"
              ? { mode: "follow-account" as const }
              : yield* selectDeviceSkills(empty, input.deviceSelection);
          const staged = yield* library.content.stage(empty, {
            localArchives: [],
            registry: { origin: input.origin, token: Option.none() },
          });
          const plan = yield* library.plan(
            {
              _tag: "Sync",
              staged,
              deviceSelection: Option.some(selection),
              pendingOrigin: Option.some(input.origin),
              acceptedBase: Option.none(),
              remote: Option.none(),
            },
            { base: snapshot },
          );
          if (isRemoteSyncPlan(plan)) return yield* new SyncLocalChanged();
          yield* library.apply({ _tag: "Apply", plan });
        }),
      };
    const remoteManifest = remote?.manifest ?? empty;
    const base = (!mismatched ? ancestry?.base_manifest : undefined) ?? empty;
    const clean =
      present && remote !== null && same(manifest, remoteManifest) && !input.keepEnabled?.length;
    const revision = remote === null ? {} : { revision_id: remote.revision_id };
    const merge = yield* around(
      { kind: "merge" },
      prepareLibraryMerge({
        base,
        local: manifest,
        remote: remoteManifest,
        ...(present ? { device: snapshot.state } : {}),
        ...(input.takeRemote ? { takeRemote: input.takeRemote } : {}),
      }),
    );
    if (merge._tag === "InvalidResolution")
      return {
        _tag: "Stopped" as const,
        result: { ...note, status: "resolution_invalid" as const, ...revision },
      };
    if (merge._tag === "Conflicted")
      return {
        _tag: "Stopped" as const,
        result: { ...note, ...conflict(merge.conflicts, remote?.revision_id) },
      };
    const selected =
      input.deviceSelection === undefined
        ? undefined
        : input.deviceSelection === "follow-account"
          ? { mode: "follow-account" as const }
          : yield* selectDeviceSkills(merge.manifest, input.deviceSelection);
    const device = withDeviceSkillSelection(merge.device, selected);
    const installation = prepareDeviceInstallation(device, merge.manifest);
    if (installation.independent && input.keepEnabled?.length)
      return yield* new OptionCombinationInvalid({
        detail:
          "--keep-enabled changes account bindings and cannot be combined with a device selection.",
      });
    const collision = yield* around(
      { kind: "check-destinations" },
      resolveSyncInstalledSkillCollisions(
        installation.manifest,
        rootFor,
        input.keepEnabled,
        device,
      ),
    );
    if (collision.invalid)
      return {
        _tag: "Stopped" as const,
        result: { ...note, status: "resolution_invalid" as const, ...revision },
      };
    if (collision.conflicts.length && !installation.independent)
      return {
        _tag: "Stopped" as const,
        result: { ...note, ...conflict(collision.conflicts, remote?.revision_id) },
      };
    const { account: desired, installation: effective } = installation.resolveEnabled(
      collision.manifest.enabled,
    );
    const transition = present
      ? yield* around(
          { kind: "check-installed-skills" },
          previewSyncInstalledSkills(
            snapshot.state,
            device,
            effective,
            rootFor,
            installation.independent,
          ),
        )
      : undefined;
    if (transition?.conflicts.length)
      return {
        _tag: "Stopped" as const,
        result: { ...note, ...conflict(transition.conflicts, remote?.revision_id) },
      };
    const facts: SyncChanges = {
      ...planLibrarySync(merge.alignedLocal, remoteManifest, desired),
      ...(merge.enabledResolution ? { enabled_resolution: merge.enabledResolution } : {}),
    };
    const prepare = (content: Library.StagedContent) => {
      const staged = structuredClone(content);
      return Effect.gen(function* () {
        if (!same(yield* libraryManifestFromLocalState(staged.state), desired))
          return yield* new StalePlan({
            message: "Staged Sync content differs from the reviewed target",
          });
        const plan = yield* library
          .plan(
            {
              _tag: "Sync",
              staged,
              acceptedBase: Option.fromUndefinedOr(ancestry),
              deviceSelection: Option.fromUndefinedOr(selected),
              pendingOrigin: Option.none(),
              remote: Option.some({
                origin: input.origin,
                libraryId: Option.fromNullishOr(remote?.library_id),
              }),
            },
            { base: snapshot },
          )
          .pipe(Effect.filterOrFail(isRemoteSyncPlan, () => new SyncLocalChanged()));
        return {
          checkCurrent:
            remote === null
              ? Effect.void
              : library.read.pipe(
                  Effect.flatMap((current) =>
                    current.revision === snapshot.revision
                      ? Effect.void
                      : Effect.fail(new SyncLocalChanged()),
                  ),
                ),
          apply: (saved: { readonly library_id: string; readonly revision_id: string }) =>
            library
              .apply({
                _tag: "ApplySynced",
                plan,
                receipt: {
                  origin: input.origin,
                  libraryId: saved.library_id,
                  revisionId: saved.revision_id,
                  manifestDigest: plan.change.staged.manifestDigest,
                  ancestry: {
                    origin: input.origin,
                    library_id: saved.library_id,
                    revision_id: saved.revision_id,
                    base_manifest: normalizeLibraryManifest(desired),
                  },
                },
              })
              .pipe(
                Effect.map((outcome) => outcome.result),
                Effect.catchTag("Library.StalePlan", () => Effect.fail(new SyncLocalChanged())),
              ),
        };
      });
    };
    return {
      _tag: "Ready" as const,
      direction: clean
        ? ("clean" as const)
        : remote === null
          ? ("push" as const)
          : !present
            ? ("pull" as const)
            : ("merge" as const),
      note,
      target: structuredClone(desired),
      plan: structuredClone(facts),
      writeRemote: remote === null || !same(desired, remoteManifest),
      collectionsToRemove: present
        ? snapshot.state.collections.filter(
            (collection) =>
              !desired.collections.some((item) => item.collection_id === collection.collection_id),
          ).length
        : 0,
      prepare,
    };
  });
}
