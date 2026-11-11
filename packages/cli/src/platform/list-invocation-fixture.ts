import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { parseDocument } from "yaml";
import * as Library from "@smolai/skit-core/library";
import { makeListDisableFixture } from "./list-disable-fixture.js";

/** Own the disposable Library and before/after filesystem evidence for an invocation change. */
export const makeListInvocationFixture = Effect.fn("Storybook.makeListInvocationFixture")(
  function* (journeyHome: string) {
    const { layer, repository } = yield* makeListDisableFixture(journeyHome);
    const fs = yield* FileSystem.FileSystem;
    const before = yield* Effect.flatMap(Library.Service, (library) => library.read).pipe(
      Effect.provide(layer),
    );
    const repositorySkill = join(repository, ".agents", "skills", "cli-ux", "SKILL.md");
    const otherSkill = join(journeyHome, ".agents", "skills", "skill-cutter", "SKILL.md");
    const repositoryBytes = yield* fs.readFile(repositorySkill);
    const otherBytes = yield* fs.readFile(otherSkill);
    const verifyApplied = Effect.gen(function* () {
      const library = yield* Library.Service;
      const after = yield* library.read;
      if (before._tag !== "Present" || after._tag !== "Present")
        return yield* Effect.die("Expected a saved fixture Library");
      const skill = after.state.skills.find((item) => item.name === "cli-ux");
      if (!skill || after.state.invocation_policies?.[skill.skill_id] !== "explicit")
        return yield* Effect.die("Expected the global explicit override to be saved");
      if (JSON.stringify(after.state.enabled) !== JSON.stringify(before.state.enabled))
        return yield* Effect.die("Invocation changes must leave enabled selections unchanged");
      if (
        !Buffer.from(repositoryBytes).equals(yield* fs.readFile(repositorySkill)) ||
        !Buffer.from(otherBytes).equals(yield* fs.readFile(otherSkill))
      )
        return yield* Effect.die("Expected repository and other Skill files unchanged");
      const installed = yield* fs.readFileString(
        join(journeyHome, ".agents", "skills", "cli-ux", "SKILL.md"),
      );
      const frontmatter = installed.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const metadata = parseDocument(frontmatter?.[1] ?? "");
      if (metadata.errors.length || metadata.get("disable-model-invocation") !== true)
        return yield* Effect.die(
          "Expected the installed metadata to require an explicit invocation",
        );
      return "cli-ux requires explicit invocation globally | repository copy and skill-cutter unchanged | enabled selections unchanged";
    });
    return { layer, verifyApplied };
  },
);
