import { Data, Effect, FileSystem } from "effect";
import { dirname, join, relative, resolve } from "node:path";
import { deterministicTreeHash } from "../artifact/skit.js";
import { copyLocalTree } from "../platform/copy-tree.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export class SkillMaterializationInvalid
  extends Data.TaggedError("Library.SkillMaterializationInvalid")<{ detail: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Correct the Skill's shared mappings in the source, then retry.";
  get message(): string {
    return this.detail;
  }
}

/** Build the self-contained Skill artifact whose digest defines a Skill Version. */
export const installedSkillHash = Effect.fn("Library.installedSkillHash")(function* (input: {
  collectionVersionPath: string;
  sourcePath: string;
  shared?: readonly { from: string; to: string }[];
}) {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-skill-artifact-" });
  const artifact = join(workspace, "artifact");
  const source =
    input.sourcePath === "."
      ? input.collectionVersionPath
      : join(input.collectionVersionPath, input.sourcePath);
  yield* copyLocalTree(source, artifact, undefined, false);
  for (const mapping of input.shared ?? []) {
    const target = resolve(artifact, mapping.to);
    if (relative(artifact, target).startsWith(".."))
      return yield* new SkillMaterializationInvalid({
        detail: `Shared mapping target escaped Skill: ${mapping.to}`,
      });
    yield* fs.makeDirectory(dirname(target), { recursive: true, mode: 0o700 });
    yield* copyLocalTree(join(input.collectionVersionPath, mapping.from), target, undefined, false);
  }
  return yield* deterministicTreeHash(artifact);
});
