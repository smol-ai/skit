import { Effect, FileSystem, Schema } from "effect";
import { Digest } from "effect/crypto";
import { digestTreeHash } from "../../artifact/skit.js";
import { TreeHasher } from "../../artifact/tree-hasher.js";
import { LinkStat } from "../../platform/link-stat.js";
import { InstallScope } from "../../vocabulary.js";
import { findDuplicates, type DuplicateScanError } from "../duplicates.js";
import { InstalledSkills } from "../installed-skills.js";
import type { StepRouting } from "../store/state-schema.js";
const sameScope = Schema.toEquivalence(InstallScope);
export const destinationsIn = (routing: StepRouting, scope: InstallScope) =>
  routing.destinations
    .filter((target) => sameScope(target.scope, scope))
    .map(({ destination, root }) => ({ destination, root }));
export const readableIn = (routing: StepRouting, scope: InstallScope) =>
  routing.readable
    .filter((root) => sameScope(root.scope, scope))
    .map(({ harness, root }) => ({ harness, root }));

/** The tree hash over Digest, so setup needs no TreeHasher service. */
export const digestTreeHasher = Effect.map(Digest.Digest, (digest) => ({
  hash: (path: string) => digestTreeHash(path).pipe(Effect.provideService(Digest.Digest, digest)),
}));

/** This device's skill folders, routed only by what the step recorded. */
export const routedInstalledSkills = Effect.fn("Library.setup.routedInstalledSkills")(function* (
  routing: StepRouting,
) {
  const context = yield* Effect.context<FileSystem.FileSystem | LinkStat | Digest.Digest>();
  const hasher = yield* digestTreeHasher;
  return yield* InstalledSkills.make({
    active: Effect.succeed(routing.active),
    destinations: (scope) => Effect.succeed(destinationsIn(routing, scope)),
    duplicates: {
      scan: (scope, names) =>
        Effect.gen(function* () {
          const warnings: DuplicateScanError[] = [];
          const readable = readableIn(routing, scope);
          const copies = names.length
            ? yield* findDuplicates(
                { destinations: destinationsIn(routing, scope), readable },
                names,
                warnings,
              )
            : [];
          return { copies, warnings, roots: readable.map(({ root }) => root) };
        }).pipe(Effect.provide(context)),
    },
  }).pipe(Effect.provideService(TreeHasher, hasher));
});
