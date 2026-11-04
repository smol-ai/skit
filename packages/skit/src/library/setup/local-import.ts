import { Effect, Option } from "effect";
import { resolveSkitSource } from "../../sources/resolve.js";
import { leavePnpmSkill } from "../../install/pnpm-skills.js";
import { describeSourceSkills, leaveResolvedPnpmSkills } from "../source-inspection.js";
import type { ImportRequest } from "../import-collection.js";

/** Capture observed local members for a later setup step. Declared Collections stay authored. */
export const localImportRequest = Effect.fn("Library.localImportRequest")(function* (
  path: string,
  importedAt: string,
) {
  const source = { type: "local" as const, path };
  yield* leavePnpmSkill(path);
  const resolved = yield* resolveSkitSource(source);
  yield* leaveResolvedPnpmSkills(source, resolved);
  if (resolved.descriptorKind === "declared") return Option.none();
  return Option.some<ImportRequest>({
    source: resolved.source,
    input: path,
    ...(resolved.revision === undefined ? {} : { revision: resolved.revision }),
    importedAt,
    skills: yield* describeSourceSkills(resolved, path),
    lockFileEntries: [],
  });
}, Effect.scoped);
