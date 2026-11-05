/** Library owns source acquisition, pnpm protection, retained import and staging lifetime. */
import { Clock, Effect } from "effect";
import * as Library from "./library.js";
import {
  describeSourceSkills,
  inspectResolvedSource,
  leaveResolvedPnpmSkills,
} from "./source-inspection.js";
import { resolveSkitSource, type ResolvedSkitSource } from "../sources/resolve.js";
import { leavePnpmSkill } from "../installed-skills/pnpm-skills.js";
import type { SkitSource } from "./library-contracts.js";

export { SkitSource } from "./library-contracts.js";
export { parseSkitSource, sourceLocator, SourceDiscoveryDiagnostic } from "../sources/resolve.js";
// Canonical failure alias keeps inferred frontend declarations on the public entry.
export type { LibraryStateWriteError } from "./library.js";
export type { PnpmSkillManaged } from "../installed-skills/pnpm-skills.js";
export type { AddNoSkills } from "./source-inspection.js";

export interface SourceRequest {
  readonly source: SkitSource;
  /** Original user input for provenance and diagnostics; acquisition uses the parsed source. */
  readonly input: string;
  readonly previousSkillPaths?: readonly string[];
  readonly registryBaseUrl?: string;
  readonly registryToken?: string;
}

const withResolvedSource = Effect.fn("Library.withResolvedSource")(function* <A, E, R>(
  request: SourceRequest,
  use: (prepared: {
    parsed: SkitSource;
    resolved: ResolvedSkitSource;
    historicalInput: string;
    registryOrigin: string | undefined;
  }) => Effect.Effect<A, E, R>,
) {
  const parsed = request.source;
  if (parsed.type === "local") yield* leavePnpmSkill(parsed.path);
  const resolved = yield* resolveSkitSource(parsed, {
    registryBaseUrl: request.registryBaseUrl,
    registryToken: request.registryToken,
    ...(request.previousSkillPaths === undefined
      ? {}
      : { previousSkillPaths: request.previousSkillPaths }),
  });
  yield* leaveResolvedPnpmSkills(parsed, resolved);
  return yield* use({
    parsed,
    resolved,
    historicalInput: request.input,
    registryOrigin: request.registryBaseUrl,
  });
}, Effect.scoped);

export const inspectSource = Effect.fn("Library.inspectSource")(function* (request: SourceRequest) {
  return yield* withResolvedSource(request, ({ parsed, resolved }) =>
    inspectResolvedSource(parsed, resolved),
  );
});

/** Keep source staging alive through Library import, then clean it up. */
export const importSource = Effect.fn("Library.importSource")(function* (request: SourceRequest) {
  return yield* withResolvedSource(request, ({ resolved, historicalInput, registryOrigin }) =>
    Effect.gen(function* () {
      const authority =
        resolved.source.type === "registry"
          ? (resolved.source.authority ?? registryOrigin)
          : undefined;
      const declaration =
        resolved.descriptorKind === "declared" && resolved.source.type === "registry"
          ? {
              namespace: resolved.source.namespace,
              slug: resolved.source.slug,
              ...(authority === undefined ? {} : { authority }),
            }
          : undefined;
      const request = {
        source: resolved.source,
        ...(declaration === undefined ? {} : { declaration }),
        input: historicalInput,
        revision: resolved.revision,
        importedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      };
      const library = yield* Library.Service;
      const imported =
        resolved.descriptorKind === "declared"
          ? yield* library.import.authored({ ...request, root: resolved.root })
          : yield* library.import.collection({
              ...request,
              skills: yield* describeSourceSkills(resolved, historicalInput),
              lockFileEntries: [],
            });
      return {
        action: imported.action,
        collection_id: imported.collection.collection_id,
        skill_ids: imported.skills.map((skill) => skill.skill_id),
        collection_version_id: imported.collectionVersionId,
        snapshot_digest: imported.snapshotDigest,
        ...(resolved.descriptorKind !== "declared" && resolved.diagnostics?.length
          ? { diagnostics: resolved.diagnostics }
          : {}),
        skills: imported.members.map((member) => ({
          name: member.name,
          verbatim_path: member.sourcePath,
        })),
      };
    }),
  );
});

export type { InstalledSkillFailure } from "../installed-skills/files.js";
export type {
  PluginManifestInvalid,
  PluginSkillConflict,
  CommandFailed,
  SourcePolicyViolation,
  ParseSourceFailure,
} from "../sources/resolve.js";
