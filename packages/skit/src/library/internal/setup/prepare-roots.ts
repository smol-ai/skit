import { Effect } from "effect";
import { dirname } from "node:path";
import { pathIsWithin } from "../../../platform/path-identity.js";
import { pathChain, samePathChain, pathEntryIdentity } from "../../../platform/path-evidence.js";
import { ensureSkillsDirectoryWritable } from "../../../installed-skills/writable.js";
import { LinkStat } from "../../../platform/link-stat.js";
import { installedPaths } from "./steps.js";
import { changeWrites } from "../../installed-update.js";
import { InstalledSkills } from "../../installed-skills.js";
import { absentEvidence, holdsEvidence, parentIsAsRecorded } from "../../folder-evidence.js";
import type { SetupStep, SetupPreparation, RecordedSetupStep } from "../../store/state-schema.js";

/** Fix the roots before the Pending operation is saved; this only reads physical identities. */
export const recordPreparation = Effect.fn("Library.recordRootPreparation")(function* (
  steps: readonly SetupStep[],
) {
  const roots = new Set<string>();
  for (const step of steps) {
    if (step._tag === "Manage")
      for (const selection of step.selections)
        for (const path of installedPaths(step.routing, selection)) roots.add(dirname(path));
    if (step._tag === "Update")
      for (const change of step.changes)
        if (
          changeWrites(change) ||
          (change.status !== "native-delete" &&
            step.versionChoices.some((choice) => choice.skillId === change.skillId))
        )
          roots.add(dirname(change.path));
  }
  if (!roots.size) return undefined;
  return {
    roots: yield* Effect.forEach([...roots], (path) =>
      Effect.map(pathChain(path), (ancestors) => ({ path, ancestors })),
    ),
    done: false,
  } satisfies SetupPreparation;
});

const changed = (path: string) => new InstalledSkills.Changed({ path });

/** No probe or mkdir until all recorded ancestors and reviewed entries still agree. */
export const prepareRoots = Effect.fn("Library.prepareRecordedRoots")(function* (
  preparation: SetupPreparation,
  steps: readonly RecordedSetupStep[],
) {
  for (const root of preparation.roots)
    if (!samePathChain(root.ancestors, yield* pathChain(root.path), !preparation.done))
      return yield* changed(root.path);
  if (preparation.done) return { preparation, steps };
  const links = yield* LinkStat;
  for (const entry of steps.flatMap((step) => step.before)) {
    if (entry._tag === "Retained") continue;
    if (entry._tag === "Absent") {
      if ((yield* pathEntryIdentity(entry.path)) !== "absent") return yield* changed(entry.path);
      const parent = yield* links.identity.lstat(entry.parent.path);
      if (
        parent.type !== "Directory" ||
        parent.dev !== entry.parent.dev ||
        parent.ino !== entry.parent.ino
      )
        return yield* changed(entry.path);
    } else if (
      !(yield* parentIsAsRecorded(entry.path, entry.parent)) ||
      !(yield* holdsEvidence(entry, entry.path))
    )
      return yield* changed(entry.path);
  }
  for (const root of preparation.roots) yield* ensureSkillsDirectoryWritable(root.path);
  const roots = yield* Effect.forEach(preparation.roots, (root) =>
    Effect.gen(function* () {
      const ancestors = yield* pathChain(root.path);
      if (!samePathChain(root.ancestors, ancestors, true)) return yield* changed(root.path);
      return { path: root.path, ancestors };
    }),
  );
  // New parent directories are now part of the operation's durable post-preparation evidence.
  const prepared = yield* Effect.forEach(steps, (saved) =>
    Effect.gen(function* () {
      const before = yield* Effect.forEach(saved.before, (entry) =>
        Effect.gen(function* () {
          if (entry._tag !== "Absent" || !roots.some((root) => pathIsWithin(root.path, entry.path)))
            return entry;
          if ((yield* pathEntryIdentity(entry.path)) !== "absent")
            return yield* changed(entry.path);
          return yield* absentEvidence(entry.path);
        }),
      );
      return { ...saved, before };
    }),
  );
  return { preparation: { roots, done: true }, steps: prepared };
});
