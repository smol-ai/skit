import { currentSkillVersion, versionBacking } from "../../library-contracts.js";
import { collectionVersionPath } from "../../collection-version.js";
import { parseSkillFrontmatter } from "../../../harnesses/frontmatter.js";
import { type LibraryState } from "../../library-state.js";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";

/** Raw description demand, deliberately not a token estimate or a harness budget claim. */
export const readDescriptionLoad = Effect.fn("Library.descriptionLoad")(function* (
  state: LibraryState,
  originalsPath: string,
  skills: readonly LibraryState["skills"][number][],
) {
  const fs = yield* FileSystem.FileSystem;
  let characters = 0;
  let unknown = 0;
  for (const skill of skills) {
    const version = currentSkillVersion(state, skill);
    const backing = version === undefined ? undefined : versionBacking(state, skill, version);
    const description =
      backing === undefined
        ? undefined
        : yield* fs
            .readFileString(
              join(
                collectionVersionPath(originalsPath, backing.copy.hash),
                backing.member.source_path,
                "SKILL.md",
              ),
            )
            .pipe(
              Effect.map((text) => parseSkillFrontmatter(text)?.description),
              Effect.orElseSucceed(() => undefined),
            );
    if (typeof description !== "string") unknown++;
    else characters += Array.from(description).length;
  }
  return { skills: skills.length, characters, unknown };
});
