import { installedSkillConflicts } from "../installed-skills/conflict.js";
import { basename, join } from "node:path";
import { Effect, Schema, type Scope } from "effect";
import * as InstalledSkills from "./installed-skills.js";
import { libraryOriginalsPath } from "./store/library-store.js";
import { emptyLibraryState, type LibraryState } from "./library-state.js";
import { type InstalledSkill } from "./device-state.js";
import type { Snapshot } from "./snapshot.js";
import { skillsToCheckForDuplicates, deviceInstallationIntent } from "./enabled.js";
import { edit } from "./library-edit.js";
import { currentSkillVersion, enabledSkillIds, versionBacking } from "./library-contracts.js";
import { collectionVersionPath } from "./collection-version.js";
import { InstalledSkillInvalid } from "./installation/install-enabled.js";
import type { SkillId } from "./entity-ids.js";
import { installedSkillName } from "../installed-skills/files.js";
import { OwnershipMarker } from "../installed-skills/ownership-marker.js";
import { InstallScope } from "./scope.js";
import { type InstallDestination } from "../installed-skills/destination.js";
import type { Request } from "./enabled-plan.js";
import type {
  Approval,
  EnabledChange,
  InstalledSkillChange,
  Intent,
  Plan,
  PlanError,
  Route,
} from "./library-plan.js";

/** A pending backup still holds the folder this record describes, so it explains its absence. */
const displaced = Effect.fn("Library.displaced")(function* (recorded: InstalledSkill) {
  const files = yield* InstalledSkills.Service;
  return (yield* files.backups.scan(recorded.root, recorded.installed_skill_id)).some(
    (backup) =>
      backup.marker.kind === "valid" &&
      backup.marker.marker.installed_skill_id === recorded.installed_skill_id &&
      backup.marker.marker.expected_hash === recorded.expected_hash,
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
 * What happens at one folder the next Library installs into, decided from what the folder holds,
 * the Library's record of it and what the user approved. Changes nothing; builds the bytes only
 * where a folder is there to compare them with. Refuses when an approved folder changed since it
 * was previewed, or does not hold exactly SKIT's bytes.
 */
const decide = Effect.fn("Library.decide")(function* (
  install: Extract<InstalledSkillChange, { readonly _tag: "Install" }>,
  folder: InstalledSkills.Folder,
  rules: {
    readonly next: LibraryState;
    readonly originalsPath: string;
    readonly approvals: readonly Approval[];
    /** Put the folder back even though the user deleted it. */
    readonly restore: boolean;
    /** Take over a folder that holds exactly SKIT's bytes, unasked. */
    readonly manageIdentical: boolean;
  },
): Effect.fn.Return<
  Extract<InstalledSkillChange, { readonly skillVersionId: unknown }>,
  PlanError,
  InstalledSkills.Service | Scope.Scope
> {
  const files = yield* InstalledSkills.Service;
  const { path, recorded } = install;
  if (
    folder.entry._tag === "Present" &&
    folder.entry.facts === null &&
    folder.entry.kind !== "SymbolicLink"
  )
    return yield* new InstalledSkillInvalid({ reason: { _tag: "NotSkillFolder", path } });
  if (folder.entry._tag === "Absent" || folder.entry.facts === null) {
    // A folder the user deleted stays deleted unless they asked to restore it, or a backup shows
    // SKIT moved it aside. An installed folder that is gone was deleted too.
    if (
      (recorded?.status === "suppressed" || recorded?.status === "installed") &&
      !rules.restore &&
      !(yield* displaced(recorded))
    )
      return { ...install, _tag: "KeepDeleted", recorded };
    return install;
  }
  const { facts } = folder.entry;
  const directory = folder.entry.kind === "Directory";
  if (facts.protection !== null) return { ...install, _tag: "Protected", reason: facts.protection };
  if (typeof facts.hash !== "string")
    return {
      ...install,
      _tag: "Unreadable",
      reason: { _tag: "InvalidTree", reason: facts.hash.reason },
    };
  // Decided against the hash an installed folder is verified with.
  const current = facts.hash;
  const { hash } = yield* files.build(install, rules.next, rules.originalsPath);
  const marker = facts.marker.kind === "valid" ? facts.marker.marker : null;
  const conflicts = installedSkillConflicts(
    { ...recorded, skill_id: install.skillId },
    facts.marker,
    current,
  );
  const [accepted] = rules.approvals.flatMap((approval) =>
    approval._tag === "AcceptEdit" && approval.installedSkillId === recorded?.installed_skill_id
      ? [approval]
      : [],
  );
  if (
    accepted !== undefined &&
    accepted.currentHash === current &&
    current === hash &&
    marker !== null &&
    Schema.toEquivalence(OwnershipMarker)(marker, accepted.marker)
  )
    return { ...install, _tag: "Manage", hash, verification: "replacement" };
  // SKIT's marker names the Installed Skill and Skill; a new selected Version is an ordinary
  // rewrite, and the hash checks below are what show a local edit.
  if (
    marker === null ||
    marker.installed_skill_id !== recorded?.installed_skill_id ||
    marker.skill_id !== install.skillId
  ) {
    if (facts.marker.kind === "absent") {
      // SKIT recorded this copy before writing its marker into the folder, and stopped between
      // the two: the folder still holds exactly SKIT's bytes, so only the marker is left to write.
      if (
        recorded?.status === "pending" &&
        recorded.path === path &&
        recorded.expected_hash === current &&
        current === hash
      )
        return { ...install, _tag: "Manage", hash, verification: "manage" };
      const manage = yield* approvedForManage(rules.approvals, path);
      if (manage !== undefined) {
        if (current !== manage.currentHash)
          return yield* new InstalledSkillInvalid({
            reason: { _tag: "ManageTargetChanged", path },
          });
        if (current !== hash)
          return yield* new InstalledSkillInvalid({
            reason: { _tag: "ManageContentMismatch", path },
          });
        return { ...install, _tag: "Manage", hash, verification: "manage" };
      }
      // Unasked managing only takes a folder that is nothing more than SKIT's bytes: the hash
      // leaves out `.git`, so a checkout with the same files, and its history, would otherwise
      // become SKIT's.
      if (
        rules.manageIdentical &&
        !facts.insideRepository &&
        current === hash &&
        directory &&
        !facts.holdsRepositoryFiles
      )
        return { ...install, _tag: "Manage", hash, verification: "manage" };
    }
    return {
      ...install,
      _tag: "Conflict",
      hash,
      currentHash: current,
      conflicts,
      expectedHash: hash,
      edited: false,
    };
  }
  if (current !== marker.expected_hash) {
    // The user approved replacing exactly this edit: it goes to recovery, and is kept there.
    if (
      rules.approvals.some(
        (approval) =>
          approval._tag === "ReplaceEdit" &&
          approval.installedSkillId === recorded?.installed_skill_id &&
          approval.currentHash === current,
      )
    )
      return { ...install, _tag: "Update", hash };
    return {
      ...install,
      _tag: "Conflict",
      hash,
      currentHash: current,
      conflicts,
      expectedHash: recorded?.expected_hash ?? marker.expected_hash,
      edited: true,
    };
  }
  // A marker that disagrees with what the Library recorded writing was not written by SKIT.
  if (recorded !== undefined && marker.expected_hash !== recorded.expected_hash)
    return {
      ...install,
      _tag: "Conflict",
      hash,
      currentHash: current,
      conflicts,
      expectedHash: recorded.expected_hash,
      edited: false,
    };
  if (current === hash)
    return marker.skill_version_id !== install.skillVersionId
      ? { ...install, _tag: "Manage", hash, verification: "marker" }
      : { ...install, _tag: "Unchanged", hash };
  return { ...install, _tag: "Update", hash };
});

export interface PlannedChanges {
  readonly next: LibraryState;
  readonly routes: readonly Route[];
  readonly folders: readonly InstalledSkills.Folder[];
  readonly changes: readonly InstalledSkillChange[];
  readonly enabled: readonly {
    readonly request: Request;
    readonly change: EnabledChange;
    readonly skillIds: readonly SkillId[];
  }[];
}

/**
 * Plan one intent: edit the Library, then compare the Installed Skills its intent names with what
 * is recorded and on disk. Builds bytes only to compare them, so they last as long as the Scope.
 */
export const planChanges = Effect.fn("Library.planChanges")(function* (
  home: string,
  base: LibraryState,
  intent: Intent,
  approvals: readonly Approval[],
): Effect.fn.Return<PlannedChanges, PlanError, InstalledSkills.Service | Scope.Scope> {
  const files = yield* InstalledSkills.Service;
  const { next, requests } = yield* edit(base, intent);
  // A plan touches only the Skills its intent names. Enabling and installing read this device's
  // folders; the others work where copies are already recorded. Uninstall names copies, below.
  // Enabling also retires the copies of Skills the Library no longer has.
  const subjects: ReadonlySet<SkillId> | undefined =
    intent._tag === "Enabled"
      ? new Set([
          ...requests.flatMap(({ calculated }) => calculated.skillIds),
          ...base.installed_skills
            .filter((copy) => !next.skills.some((skill) => skill.skill_id === copy.skill_id))
            .map((copy) => copy.skill_id),
        ])
      : intent._tag === "Update" || intent._tag === "Install"
        ? intent.skills === undefined
          ? undefined
          : new Set(intent.skills)
        : intent._tag === "Remove"
          ? new Set(
              base.skills
                .filter((skill) => skill.collection_id === intent.collectionId)
                .map((skill) => skill.skill_id),
            )
          : new Set();
  const selected = (skillId: SkillId) => subjects === undefined || subjects.has(skillId);
  const converges = intent._tag === "Enabled" || intent._tag === "Install";
  const enabling = requests.filter(({ request }) => request.enabled);
  // Enabling a Skill puts back its deleted folders; otherwise only an approved one comes back.
  const enabled = new Set<string>(enabling.flatMap(({ calculated }) => calculated.skillIds));
  const restored = new Set<string>(
    approvals.flatMap((approval) =>
      approval._tag === "Restore" ? [approval.installedSkillId] : [],
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
  // Physical roots, so a configured symlink alias is the same place.
  const identities = new Map<string, { readonly key: string; readonly canonicalPath: string }>();
  const identify = Effect.fn("Library.identifyRoot")(function* (root: string) {
    const known = identities.get(root);
    if (known !== undefined) return known;
    const identity = yield* files.identify(root);
    identities.set(root, identity);
    return identity;
  });
  for (const root of [
    ...base.installed_skills.map((recorded) => recorded.root),
    ...base.repositories.map((repository) => repository.root),
  ])
    yield* identify(root);
  const canonical = (root: string) => identities.get(root)?.canonicalPath ?? root;
  /** A recorded copy's scope: the repository whose root holds it, else global. */
  const scopeOf = (recorded: InstalledSkill): InstallScope => {
    const path = canonical(recorded.root);
    const repository = base.repositories.find((item) => {
      const root = canonical(item.root);
      return path === root || path.startsWith(`${root}/`);
    });
    return repository === undefined
      ? { kind: "global" }
      : { kind: "repository", root: repository.root };
  };
  const recordedCopies = base.installed_skills.filter((recorded) => selected(recorded.skill_id));
  const routes: readonly Route[] = converges
    ? yield* Effect.forEach(scopes, (scope) =>
        Effect.map(files.destinations(scope), (destinations): Route => ({ scope, destinations })),
      )
    : scopes.map((scope) => ({
        scope,
        destinations: recordedCopies
          .filter((recorded) => Schema.toEquivalence(InstallScope)(scopeOf(recorded), scope))
          .map((recorded) => ({ destination: recorded.destination, root: recorded.root }))
          .filter(
            (target, index, all) =>
              all.findIndex(
                (other) => other.destination === target.destination && other.root === target.root,
              ) === index,
          ),
      }));
  for (const root of routes.flatMap((route) => route.destinations.map((target) => target.root)))
    yield* identify(root);
  const routeAt = (scope: InstallScope) =>
    routes.find((route) => Schema.toEquivalence(InstallScope)(route.scope, scope));
  const active: readonly InstallDestination[] = converges
    ? yield* files.active
    : [...new Set(recordedCopies.map((recorded) => recorded.destination))];
  const keys = new Map([...identities].map(([root, identity]) => [root, identity.key]));
  const at = (recorded: InstalledSkill, target: InstalledSkills.Destination) =>
    recorded.destination === target.destination &&
    keys.get(recorded.root) === keys.get(target.root);

  // What happens at the folder of every Installed Skill the next Library has.
  const installing: {
    readonly change: Extract<InstalledSkillChange, { readonly skillVersionId: unknown }>;
    readonly folder: InstalledSkills.Folder;
  }[] = [];
  for (const scoped of intended) {
    for (const target of routeAt(scoped.scope)?.destinations ?? [])
      for (const skillId of enabledSkillIds(next, scoped.enabled).filter(selected)) {
        const skill = next.skills.find((item) => item.skill_id === skillId);
        const version = skill === undefined ? undefined : currentSkillVersion(next, skill);
        if (
          skill === undefined ||
          version === undefined ||
          versionBacking(next, skill, version) === undefined
        )
          return yield* new InstalledSkillInvalid({
            reason: { _tag: "VersionMissing", kind: "enabled" },
          });
        const path = join(target.root, yield* installedSkillName(skill.name));
        const recorded = base.installed_skills.find(
          (item) =>
            item.skill_id === skill.skill_id &&
            at(item, target) &&
            basename(item.path) === basename(path),
        );
        // Without this device's folders, a copy is brought up to date only where one is recorded.
        if (!converges && recorded === undefined) continue;
        const folder = yield* files.inspect(path);
        const change = yield* decide(
          {
            _tag: "Install",
            skillId: skill.skill_id,
            skillVersionId: version.skill_version_id,
            destination: target.destination,
            root: target.root,
            path,
            invocation: scoped.invocation_policies?.[skill.skill_id] ?? "declared",
            ...(recorded === undefined ? {} : { recorded }),
          },
          folder,
          {
            next,
            originalsPath: libraryOriginalsPath(home),
            approvals,
            restore:
              enabled.has(skill.skill_id) ||
              (recorded !== undefined && restored.has(recorded.installed_skill_id)),
            // Enabling may take over a folder that is exactly SKIT's bytes; updating never does.
            manageIdentical: enabling.some(
              ({ request }) =>
                routeAt(request.scope)?.destinations.some((other) => other.root === target.root) ??
                false,
            ),
          },
        );
        installing.push({ change, folder });
      }
  }

  // What happens to every recorded Installed Skill the next Library no longer has.
  const uninstalling: {
    readonly change: Exclude<InstalledSkillChange, { readonly skillVersionId: unknown }>;
    readonly folder: InstalledSkills.Folder;
  }[] = [];
  for (const recorded of intent._tag === "Uninstall"
    ? base.installed_skills.filter((item) => intent.copies.includes(item.installed_skill_id))
    : base.installed_skills.filter(
        (item) =>
          selected(item.skill_id) &&
          !installing.some(
            ({ change }) =>
              change.skillId === item.skill_id &&
              at(item, change) &&
              basename(change.path) === basename(item.path),
          ),
      )) {
    const folder = yield* files.inspect(recorded.path);
    const facts = folder.entry._tag === "Present" ? folder.entry.facts : null;
    const change = yield* Effect.gen(function* (): Effect.fn.Return<
      Exclude<InstalledSkillChange, { readonly skillVersionId: unknown }>,
      PlanError,
      never
    > {
      if (facts === null) return { _tag: "Forget", recorded };
      if (facts.protection !== null)
        return { _tag: "Protected", recorded, reason: facts.protection };
      const current = yield* files.hash(recorded.path);
      const marker = facts.marker.kind === "valid" ? facts.marker.marker : null;
      // Still the folder SKIT wrote: it goes to recovery.
      if (
        marker !== null &&
        marker.skill_id === recorded.skill_id &&
        marker.installed_skill_id === recorded.installed_skill_id &&
        current === marker.expected_hash
      )
        return { _tag: "Uninstall", recorded };
      // A Skill still installed at this destination elsewhere is moving; an edited folder is refused.
      const moving = installing.some(
        ({ change }) =>
          change.skillId === recorded.skill_id && change.destination === recorded.destination,
      );
      // Otherwise a folder without SKIT's marker was never SKIT's to remove: only its record goes.
      if (facts.marker.kind === "absent" && !moving && intent._tag !== "Uninstall")
        return { _tag: "Forget", recorded };
      // An edited folder where agents read it, or of a Skill the Library no longer has, is
      // refused; elsewhere it is kept and reported, so it cannot block every later update.
      if (
        intent._tag === "Uninstall" ||
        moving ||
        !next.skills.some((skill) => skill.skill_id === recorded.skill_id) ||
        active.some((destination) => destination === recorded.destination)
      )
        return {
          _tag: "Refuse",
          recorded,
        };
      return {
        _tag: "Conflict",
        recorded,
        currentHash: current,
        conflicts: installedSkillConflicts(recorded, facts.marker, current),
      };
    });
    uninstalling.push({ change, folder });
  }

  // The originals each Installed Skill is built from: a change to them makes the plan stale.
  const originals = [
    ...new Set(
      installing.flatMap(({ change }) => {
        const skill = next.skills.find((candidate) => candidate.skill_id === change.skillId);
        const version = skill?.versions.find(
          (candidate) => candidate.skill_version_id === change.skillVersionId,
        );
        const backing =
          skill === undefined || version === undefined
            ? undefined
            : versionBacking(next, skill, version);
        return backing === undefined
          ? []
          : [collectionVersionPath(libraryOriginalsPath(home), backing.copy.hash)];
      }),
    ),
  ];
  const folders = [
    ...installing.map(({ folder }) => folder),
    ...(yield* Effect.forEach(originals, (path) => files.inspect(path))),
    ...uninstalling
      .filter(({ folder }) => !installing.some((item) => item.folder.path === folder.path))
      .map(({ folder }) => folder),
  ].sort((left, right) => left.path.localeCompare(right.path));

  // What each enabled change shows: duplicates and unmanaged folders, and whether it repairs.
  const shown: { request: Request; change: EnabledChange; skillIds: readonly SkillId[] }[] = [];
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
    const subject = (skillId: SkillId) => calculated.skillIds.includes(skillId);
    const installedHere = installing.filter(({ change }) =>
      route?.destinations.some(
        (target) => target.root === change.root && target.destination === change.destination,
      ),
    );
    const uninstalledHere = uninstalling.filter(({ change }) =>
      route?.destinations.some((target) => at(change.recorded, target)),
    );
    const unmanaged = request.enabled
      ? installedHere.flatMap(({ change, folder }) =>
          subject(change.skillId) &&
          folder.entry._tag === "Present" &&
          folder.entry.kind !== "SymbolicLink" &&
          folder.entry.facts?.marker.kind !== "valid"
            ? [{ destination: change.destination, path: change.path }]
            : [],
        )
      : [];
    const repairs = (change: InstalledSkillChange) =>
      change._tag !== "Unchanged" && change._tag !== "KeepDeleted" && change._tag !== "Protected";
    const repair =
      !calculated.plan.changed &&
      (request.enabled
        ? [
            ...installedHere.map(({ change }) => ({ change, skillId: change.skillId })),
            ...uninstalledHere.map(({ change }) => ({ change, skillId: change.recorded.skill_id })),
          ].some(({ change, skillId }) => repairs(change) && subject(skillId))
        : uninstalledHere.some(({ change }) => repairs(change)));
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

  return {
    next,
    routes,
    folders,
    // Every install comes before any uninstall: apply carries them out in this order.
    changes: [...installing, ...uninstalling].map(({ change }): InstalledSkillChange => change),
    enabled: shown,
  };
});

/**
 * Plan against the Library the front end showed, never a fresh read: apply refuses the plan if the
 * Library has changed since. Inputs are copied, so the plan never aliases its caller's values.
 */
export const planIntent = Effect.fn("Library.plan")(function* (
  intent: Intent,
  options: {
    readonly home: string;
    readonly base: Snapshot;
    readonly approvals?: readonly Approval[];
  },
) {
  const snapshot = structuredClone(options.base);
  const base = snapshot._tag === "Present" ? snapshot.state : emptyLibraryState();
  const approvals = structuredClone(options.approvals ?? []);
  const reviewed = structuredClone(intent);
  const planned = yield* Effect.scoped(planChanges(options.home, base, reviewed, approvals));
  const plan = {
    baseRevision: snapshot.revision,
    approvals,
    routes: planned.routes,
    folders: planned.folders,
    next: planned.next,
    changes: [...planned.enabled.map(({ change }) => change), ...planned.changes],
  };
  switch (reviewed._tag) {
    case "Enabled":
      return { ...plan, _tag: "Enabled", intent: reviewed } satisfies Plan;
    case "Remove":
      return { ...plan, _tag: "Remove", intent: reviewed } satisfies Plan;
    case "Update":
      return { ...plan, _tag: "Update", intent: reviewed } satisfies Plan;
    case "Install":
      return { ...plan, _tag: "Install", intent: reviewed } satisfies Plan;
    case "Uninstall":
      return { ...plan, _tag: "Uninstall", intent: reviewed } satisfies Plan;
  }
});
