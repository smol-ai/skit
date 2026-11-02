import { join } from "node:path";
import { DateTime, Effect, Result, Schema, type Scope } from "effect";
import { InstalledSkills } from "./installed-skills.js";
import * as InstalledSkillStatus from "./installed-skill-status.js";
import { LibraryStore } from "./store/library-store.js";
import type { LibraryState, InstalledSkill } from "./library-state.js";
import type { Step, Wanted } from "./plan-steps.js";
import type { Request } from "./enabled-plan.js";
import { skillsToCheckForDuplicates, deviceInstallationIntent } from "./enabled.js";
import { edit } from "./library-edit.js";
import { currentSkillVersion, enabledSkillIds, versionBacking } from "./library-contracts.js";
import { collectionVersionPath } from "./collection-version.js";
import { InstalledSkillInvalid } from "./installation/install-enabled.js";
import { makeInstalledSkillId, type InstalledSkillId, type SkillId } from "./entity-ids.js";
import { decide, installedSkillName } from "../install/files.js";
import { declaredInvocationIntent, overrideInvocationIntent } from "../install/policy.js";
import { InstallScope, type Hash, type InstallDestination } from "../vocabulary.js";
import type { Approval, BindingChange, Change, Intent, PlanError, Route } from "./library-plan.js";

type AcceptEdit = Extract<Approval, { readonly _tag: "AcceptEdit" }>;
type ReplaceEdit = Extract<Approval, { readonly _tag: "ReplaceEdit" }>;

/** One enabled change with the request it came from and the Skills it covers. */
export interface EnabledRequest {
  readonly request: Request;
  readonly change: BindingChange;
  readonly skillIds: readonly SkillId[];
}

/** Everything plan shows and apply carries out. Builds live as long as the Scope. */
export interface Work {
  readonly next: LibraryState;
  readonly routes: readonly Route[];
  readonly steps: readonly Step[];
  readonly folders: readonly InstalledSkills.Observed[];
  readonly changes: readonly Change[];
  readonly requests: readonly EnabledRequest[];
}

/** What a recorded copy's folder holds, and whether it is still the copy SKIT wrote. */
type Ownership =
  | { readonly _tag: "Absent"; readonly read: InstalledSkills.Observed }
  | {
      readonly _tag: "Protected";
      readonly read: InstalledSkills.Observed;
      readonly reason: InstalledSkills.Protection;
      readonly hash?: Hash;
    }
  | {
      readonly _tag: "Edited";
      readonly read: InstalledSkills.Observed;
      readonly hash: Hash;
      readonly marked: boolean;
    }
  | { readonly _tag: "Intact"; readonly read: InstalledSkills.Observed; readonly hash: Hash };

/** Whether a recorded copy is still the one SKIT wrote, and its folder as read. Changes nothing. */
const ownership = Effect.fn("Library.ownership")(function* (
  copy: InstalledSkill,
): Effect.fn.Return<Ownership, InstalledSkills.Cause, InstalledSkills.Service> {
  const files = yield* InstalledSkills.Service;
  const read = yield* files.inspect(copy.path);
  if (read.entry._tag === "Absent" || read.entry.facts === null) return { _tag: "Absent", read };
  const { marker, protection, hash: folderHash } = read.entry.facts;
  if (protection !== null)
    return {
      _tag: "Protected",
      read,
      reason: protection,
      ...(typeof folderHash === "string" ? { hash: folderHash } : {}),
    };
  const hash = yield* files.hash(copy.path);
  return marker.kind !== "valid" ||
    marker.marker.skill_id !== copy.skill_id ||
    marker.marker.installed_skill_id !== copy.installed_skill_id ||
    hash !== marker.marker.expected_hash
    ? { _tag: "Edited", read, hash, marked: marker.kind !== "absent" }
    : { _tag: "Intact", read, hash };
});

/** A pending backup still holds the copy this row describes, so it explains its absence. */
const displaced = Effect.fn("Library.displaced")(function* (copy: InstalledSkill) {
  const files = yield* InstalledSkills.Service;
  return (yield* files.backups.scan(copy.root, copy.installed_skill_id)).some(
    (backup) =>
      backup.marker.kind === "valid" &&
      backup.marker.marker.installed_skill_id === copy.installed_skill_id &&
      backup.marker.marker.expected_hash === copy.expected_hash,
  );
});

/** The approved folder at this path, compared by physical path. */
const approvedForManage = Effect.fn("Library.approvedForManage")(function* (
  approvals: readonly Approval[],
  path: string,
) {
  const files = yield* InstalledSkills.Service;
  const target = (yield* files.identify(path)).key;
  for (const approval of approvals)
    if (approval._tag === "Manage")
      for (const approved of [approval.manage.path, ...(approval.manage.equalPaths ?? [])])
        if ((yield* files.identify(approved)).key === target) return approval.manage;
  return undefined;
});

/**
 * Plan one intent: edit the Library, then compare the copies it should have installed with what
 * is recorded and on disk. Builds each wanted copy, so the Scope must outlive any apply.
 */
export const work = Effect.fn("Library.work")(function* (
  base: LibraryState,
  intent: Intent,
  approvals: readonly Approval[],
): Effect.fn.Return<Work, PlanError, Scope.Scope | LibraryStore | InstalledSkills.Service> {
  const store = yield* LibraryStore;
  const files = yield* InstalledSkills.Service;
  const { next, requests } = yield* edit(base, intent);
  const enabling = requests.filter(({ request }) => request.enabled);
  // Enabling a Skill puts back its deleted copies; otherwise only an approved copy comes back.
  const enabled = new Set<string>(enabling.flatMap(({ calculated }) => calculated.skillIds));
  const restored = new Set<string>(
    approvals.flatMap((approval) =>
      approval._tag === "Restore" ? [approval.installedSkillId] : [],
    ),
  );
  const restore = (copy: InstalledSkills.Copy) =>
    enabled.has(copy.skillId) || restored.has(copy.installedSkillId);
  const accepted = new Map(
    approvals.flatMap((approval): [InstalledSkillId, AcceptEdit][] =>
      approval._tag === "AcceptEdit" ? [[approval.installedSkillId, approval]] : [],
    ),
  );
  const replaced = new Map(
    approvals.flatMap((approval): [InstalledSkillId, ReplaceEdit][] =>
      approval._tag === "ReplaceEdit" ? [[approval.installedSkillId, approval]] : [],
    ),
  );

  // Where every scope this device uses, or this intent touches, installs.
  const intended = intent._tag === "Uninstall" ? [] : deviceInstallationIntent(next).byScope;
  const scopes = [
    ...intended.map((item) => item.scope),
    ...requests.map(({ request }) => request.scope),
  ].filter(
    (scope, index, all) =>
      all.findIndex((other) => Schema.toEquivalence(InstallScope)(scope, other)) === index,
  );
  const routes = yield* Effect.forEach(scopes, (scope) =>
    Effect.map(files.destinations(scope), (destinations): Route => ({ scope, destinations })),
  );
  const routeAt = (scope: InstallScope) =>
    routes.find((route) => Schema.toEquivalence(InstallScope)(route.scope, scope));
  const active: readonly InstallDestination[] =
    intent._tag === "Uninstall" ? [] : yield* files.active;

  // Physical roots, so a configured symlink alias is the same place.
  const keys = new Map<string, string>();
  for (const root of new Set([
    ...routes.flatMap((route) => route.destinations.map((target) => target.root)),
    ...base.installed_skills.map((copy) => copy.root),
  ]))
    keys.set(root, (yield* files.identify(root)).key);
  const at = (copy: InstalledSkill, target: InstalledSkills.Destination) =>
    copy.destination === target.destination && keys.get(copy.root) === keys.get(target.root);

  // Every copy the next Library should have installed, built so it can be compared.
  const wanted: Wanted[] = [];
  for (const enabled of intended) {
    for (const target of routeAt(enabled.scope)?.destinations ?? [])
      for (const skillId of enabledSkillIds(next, enabled.enabled)) {
        const skill = next.skills.find((item) => item.skill_id === skillId);
        const version = skill === undefined ? undefined : currentSkillVersion(next, skill);
        if (
          skill === undefined ||
          version === undefined ||
          versionBacking(next, skill, version) === undefined
        )
          return yield* new InstalledSkillInvalid({
            detail: "An enabled Skill has no selected retained Version",
          });
        const prior = base.installed_skills.find(
          (copy) => copy.skill_id === skill.skill_id && at(copy, target),
        );
        const policy = enabled.invocation_policies?.[skill.skill_id];
        const copy: InstalledSkills.Copy = {
          state: next,
          originalsPath: store.originalsPath,
          installedSkillId: prior?.installed_skill_id ?? makeInstalledSkillId(),
          skillId: skill.skill_id,
          skillVersionId: version.skill_version_id,
          invocationIntent:
            policy === undefined ? declaredInvocationIntent : overrideInvocationIntent(policy),
        };
        const name = yield* installedSkillName(skill.name);
        const path = join(target.root, name);
        wanted.push({
          copy,
          destination: target,
          name,
          path,
          prior,
          folder: yield* files.inspect(path),
        });
      }
  }

  // What happens at each wanted copy's folder.
  const installing: Step[] = [];
  for (const item of wanted) {
    const { copy, path, prior, folder } = item;
    const facts = folder.entry._tag === "Present" ? folder.entry.facts : null;
    const at = {
      skillId: copy.skillId,
      destination: item.destination.destination,
      path,
      skillVersionId: copy.skillVersionId,
      ...(prior === undefined
        ? {}
        : {
            recorded: { installedSkillId: prior.installed_skill_id, hash: prior.expected_hash },
          }),
      ...(facts !== null && typeof facts.hash === "string" ? { currentHash: facts.hash } : {}),
      evidence: folder.evidence,
    };
    if (folder.entry._tag === "Present" && facts === null && folder.entry.kind !== "SymbolicLink")
      return yield* new InstalledSkillInvalid({ detail: `Not a skill folder: ${path}` });
    if (facts === null) {
      // A copy the user deleted stays deleted unless they asked to restore it, or a backup
      // shows SKIT moved it aside. An installed copy whose folder is gone was deleted too.
      if (
        (prior?.status === "suppressed" || prior?.status === "installed") &&
        !restore(copy) &&
        !(yield* displaced(prior))
      ) {
        installing.push({
          _tag: "KeepDeleted",
          change: { ...at, _tag: "KeepDeleted" },
          wanted: item,
          prior:
            prior.status === "suppressed"
              ? prior
              : InstalledSkillStatus.suppressed(prior, DateTime.formatIso(yield* DateTime.now)),
        });
        continue;
      }
      installing.push({ _tag: "Install", change: { ...at, _tag: "Install" }, wanted: item });
      continue;
    }
    if (facts.protection !== null) {
      const reason = facts.protection;
      installing.push({
        _tag: "Protected",
        change: { ...at, _tag: "Protected", reason },
        wanted: item,
        reason,
      });
      continue;
    }
    if (typeof facts.hash !== "string") {
      const reason = `${facts.hash.reason}: ${path}`;
      installing.push({
        _tag: "Unreadable",
        change: { ...at, _tag: "Unreadable", reason },
        wanted: item,
        reason,
      });
      continue;
    }
    const staged = yield* files.build(copy, item.destination);
    const built = { ...at, wantedHash: staged.hash };
    const recorded = prior?.installed_skill_id === copy.installedSkillId ? prior : undefined;
    const approval = accepted.get(copy.installedSkillId);
    const manage = yield* approvedForManage(approvals, path);
    // Decided against the hash an installed copy is verified with; an unreadable folder fails.
    const decided = decide(
      {
        marker: facts.marker,
        hash: facts.hash,
        directory: folder.entry._tag === "Present" && folder.entry.kind === "Directory",
        insideRepository: facts.insideRepository,
        holdsRepositoryFiles: facts.holdsRepositoryFiles,
        approvedForManage: manage !== undefined,
      },
      {
        installedSkillId: copy.installedSkillId,
        skillId: copy.skillId,
        skillVersionId: copy.skillVersionId,
        hash: staged.hash,
        recordedHash: recorded?.expected_hash,
        manage: manage === undefined ? undefined : { hash: manage.currentHash },
        // Enabling may take over a folder that is exactly SKIT's bytes; updating never does.
        manageIdentical: enabling.some(
          ({ request }) =>
            routeAt(request.scope)?.destinations.some(
              (target) => target.root === item.destination.root,
            ) ?? false,
        ),
        replacement:
          approval === undefined
            ? undefined
            : { hash: approval.currentHash, marker: approval.marker },
      },
    );
    if (Result.isFailure(decided))
      return yield* new InstalledSkillInvalid({ detail: `${decided.failure}: ${path}` });
    const decision = decided.success;
    switch (decision._tag) {
      case "KeepSuppressed":
        // decide keeps a copy deleted only when its folder is gone, which is handled above.
        return yield* new InstalledSkillInvalid({
          detail: `Deleted copy still present: ${path}`,
        });
      case "Manage":
        installing.push({
          _tag: "Manage",
          change: { ...built, _tag: "Manage", verification: decision.verification },
          wanted: item,
          staged,
          verification: decision.verification,
        });
        break;
      case "Conflict": {
        // The user approved replacing exactly this edit: it goes to recovery, and is kept there.
        if (decision.edited && replaced.get(copy.installedSkillId)?.currentHash === decision.hash) {
          installing.push({
            _tag: "Update",
            change: { ...built, _tag: "Update" },
            wanted: item,
            staged,
          });
          break;
        }
        installing.push({
          _tag: "Conflict",
          change: {
            ...built,
            _tag: "Conflict",
            edited: decision.edited,
            currentHash: decision.hash,
          },
          wanted: item,
          staged,
          edited: decision.edited,
          hash: decision.hash,
          expectedHash: decision.edited ? decision.expectedHash : staged.hash,
        });
        break;
      }
      case "Unchanged":
        installing.push({
          _tag: "Unchanged",
          change: { ...built, _tag: "Unchanged" },
          wanted: item,
          staged,
        });
        break;
      case "Replace":
        installing.push({
          _tag: "Update",
          change: { ...built, _tag: "Update" },
          wanted: item,
          staged,
        });
        break;
      case "Install":
        installing.push({ _tag: "Install", change: { ...at, _tag: "Install" }, wanted: item });
        break;
    }
  }

  // Every recorded copy nothing wants any more.
  const uninstalling: Step[] = [];
  const unwanted =
    intent._tag === "Uninstall"
      ? base.installed_skills.filter((copy) => intent.copies.includes(copy.installed_skill_id))
      : base.installed_skills.filter(
          (copy) =>
            !wanted.some(
              (item) =>
                item.copy.installedSkillId === copy.installed_skill_id ||
                (item.copy.skillId === copy.skill_id && at(copy, item.destination)),
            ),
        );
  for (const copy of unwanted) {
    const owned = yield* ownership(copy);
    const change = {
      skillId: copy.skill_id,
      destination: copy.destination,
      path: copy.path,
      skillVersionId: copy.skill_version_id,
      recorded: { installedSkillId: copy.installed_skill_id, hash: copy.expected_hash },
      ...(owned._tag === "Absent" || owned.hash === undefined ? {} : { currentHash: owned.hash }),
      evidence: owned.read.evidence,
    };
    if (owned._tag === "Protected") {
      const { reason } = owned;
      uninstalling.push({
        _tag: "Protected",
        change: { ...change, _tag: "Protected", reason },
        copy,
        reason,
      });
      continue;
    }
    if (owned._tag === "Absent") {
      uninstalling.push({ _tag: "Forget", change: { ...change, _tag: "Forget" }, copy });
      continue;
    }
    if (owned._tag === "Intact") {
      uninstalling.push({ _tag: "Uninstall", change: { ...change, _tag: "Uninstall" }, copy });
      continue;
    }
    // A copy still wanted elsewhere at its destination is moving; an edited one is refused.
    const moving = wanted.some(
      (item) =>
        item.copy.skillId === copy.skill_id && item.destination.destination === copy.destination,
    );
    // Otherwise a folder without SKIT's marker was never SKIT's to remove: only its record goes.
    if (!owned.marked && !moving && intent._tag !== "Uninstall") {
      uninstalling.push({ _tag: "Forget", change: { ...change, _tag: "Forget" }, copy });
      continue;
    }
    // An edited copy where agents read it, or of a Skill the Library no longer has, is refused;
    // elsewhere it is kept and reported, so it cannot block every later update.
    if (
      intent._tag === "Uninstall" ||
      moving ||
      !next.skills.some((skill) => skill.skill_id === copy.skill_id) ||
      active.some((destination) => destination === copy.destination)
    ) {
      const detail = `Refusing to remove modified Skill at ${copy.path}`;
      uninstalling.push({ _tag: "Refuse", change: { ...change, _tag: "Refuse", detail }, copy });
      continue;
    }
    uninstalling.push({
      _tag: "Keep",
      change: { ...change, _tag: "Conflict", edited: true, currentHash: owned.hash },
      copy,
      hash: owned.hash,
    });
  }

  const steps = [...installing, ...uninstalling];
  // The originals each wanted copy is built from: a change to them makes the plan stale.
  const originals = [
    ...new Set(
      wanted.flatMap((item) => {
        const skill = next.skills.find((candidate) => candidate.skill_id === item.copy.skillId);
        const version = skill?.versions.find(
          (candidate) => candidate.skill_version_id === item.copy.skillVersionId,
        );
        const backing =
          skill === undefined || version === undefined
            ? undefined
            : versionBacking(next, skill, version);
        return backing === undefined
          ? []
          : [collectionVersionPath(store.originalsPath, backing.copy.hash)];
      }),
    ),
  ];
  const folders = [
    ...wanted.map((item) => item.folder),
    ...(yield* Effect.forEach(originals, (path) => files.inspect(path))),
    ...(yield* Effect.forEach(
      unwanted.filter((copy) => !wanted.some((item) => item.path === copy.path)),
      (copy) => files.inspect(copy.path),
    )),
  ].sort((left, right) => left.path.localeCompare(right.path));

  // What each enabled change shows: duplicates and unmanaged folders, and whether it repairs.
  const shown: EnabledRequest[] = [];
  for (const { request, calculated } of requests) {
    const route = routeAt(request.scope);
    const duplicates = yield* files.duplicates.scan(
      request.scope,
      skillsToCheckForDuplicates(
        base,
        request.scope,
        request.enabled ? calculated.plan.skills : [],
        calculated.newlyEnabledSkills,
      ),
    );
    const here = steps.filter((step) =>
      route?.destinations.some((target) =>
        "wanted" in step
          ? step.wanted.destination.root === target.root &&
            step.wanted.destination.destination === target.destination
          : at(step.copy, target),
      ),
    );
    const subject = (skillId: SkillId) => calculated.skillIds.includes(skillId);
    const unmanaged = request.enabled
      ? wanted.flatMap((item) =>
          subject(item.copy.skillId) &&
          here.some((step) => "wanted" in step && step.wanted === item) &&
          item.folder.entry._tag === "Present" &&
          item.folder.entry.kind !== "SymbolicLink" &&
          item.folder.entry.facts?.marker.kind !== "valid"
            ? [{ destination: item.destination.destination, path: item.path }]
            : [],
        )
      : [];
    const repair =
      !calculated.plan.changed &&
      here.some(
        (step) =>
          step._tag !== "Unchanged" &&
          step._tag !== "KeepDeleted" &&
          step._tag !== "Protected" &&
          (request.enabled ? subject(step.change.skillId) : "copy" in step),
      );
    shown.push({
      request,
      skillIds: calculated.skillIds,
      change: {
        ...calculated.plan,
        _tag: request.enabled ? "Enable" : "Disable",
        ...(repair ? { repair } : {}),
        ...(duplicates.copies.length ? { duplicates: duplicates.copies } : {}),
        ...(duplicates.warnings.length ? { warnings: duplicates.warnings } : {}),
        ...(unmanaged.length ? { unmanaged_destinations: unmanaged } : {}),
      },
    });
  }

  const removal: Change[] =
    intent._tag === "Remove"
      ? [
          {
            _tag: "Remove",
            collectionId: intent.collectionId,
            skillIds: base.skills
              .filter((skill) => skill.collection_id === intent.collectionId)
              .map((skill) => skill.skill_id),
          },
        ]
      : [];
  return {
    next,
    routes,
    steps,
    folders,
    changes: [...shown.map((item) => item.change), ...removal, ...steps.map((step) => step.change)],
    requests: shown,
  };
});
