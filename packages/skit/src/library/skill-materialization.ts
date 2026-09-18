import { Effect, FileSystem, Schema } from "effect";
import { dirname, join, relative, resolve } from "node:path";
import { deterministicTreeHashEffect } from "../artifact/skit.js";
import { copyLocalTreeEffect } from "../platform/copy-tree.js";

export class SkillMaterializationInvalid extends Schema.TaggedError<SkillMaterializationInvalid>()(
  "Library.SkillMaterializationInvalid",
  { detail: Schema.String },
) {}

/** Build the self-contained Skill artifact whose digest defines a Skill Version. */
export const materializedSkillDigestEffect = Effect.fn("Library.materializedSkillDigest")(
  function* (input: {
    retainedRoot: string;
    sourcePath: string;
    shared?: readonly { from: string; to: string }[];
  }) {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-skill-artifact-" });
    const artifact = join(workspace, "artifact");
    const source =
      input.sourcePath === "." ? input.retainedRoot : join(input.retainedRoot, input.sourcePath);
    yield* copyLocalTreeEffect(source, artifact, undefined, false);
    for (const mapping of input.shared ?? []) {
      const target = resolve(artifact, mapping.to);
      if (relative(artifact, target).startsWith(".."))
        return yield* new SkillMaterializationInvalid({
          detail: `Shared mapping target escaped Skill: ${mapping.to}`,
        });
      yield* fs.makeDirectory(dirname(target), { recursive: true, mode: 0o700 });
      yield* copyLocalTreeEffect(join(input.retainedRoot, mapping.from), target, undefined, false);
    }
    return yield* deterministicTreeHashEffect(artifact);
  },
);
