import { pinnedCollections } from "./storybook-fixtures.js";
import { ConfigProvider, Effect, FileSystem, Layer } from "effect";
import { join } from "node:path";
import * as Library from "@smolai/skit-core/library";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import { makeMachineId } from "@smolai/skit-core/universal/consumer";
import { deterministicTreeHash } from "@smolai/skit-core/author";

/**
 * A Library holding the real swyxio/skills Collection with both Skills enabled globally and cli-ux
 * also enabled in one repository, installed for Codex under the fixture person's `~`.
 */
export const makeListDisableFixture = Effect.fn("Storybook.makeListDisableFixture")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const account = root;
  const home = join(root, ".skit");
  const source = join(root, "src", "swyxio-skills");
  const repository = join(root, "dev", "app");
  const globalSkills = join(account, ".agents", "skills");
  yield* fs.copy(join(yield* pinnedCollections, "swyxio"), source);
  yield* fs.makeDirectory(join(repository, ".git"), { recursive: true });
  yield* fs.makeDirectory(globalSkills, { recursive: true });
  const layer = Library.layer({
    home,
    roots: {
      home: account,
      configHome: join(account, ".config"),
      overrides: { codex: [globalSkills] },
    },
  }).pipe(
    Layer.provideMerge(skitConfigurationLayer(home)),
    Layer.provideMerge(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          CODEX_HOME: join(account, ".codex"),
          CLAUDE_CONFIG_DIR: join(account, ".claude"),
        }),
      ),
    ),
  );
  yield* Effect.gen(function* () {
    const library = yield* Library.Service;
    const imported = yield* library.import.collection({
      machineId: makeMachineId(),
      source: { type: "github", owner: "swyxio", repository: "skills" },
      input: source,
      importedAt: "2026-01-01T00:00:00.000Z",
      skills: yield* Effect.forEach(["cli-ux", "skill-cutter"], (skill) =>
        Effect.map(deterministicTreeHash(join(source, skill)), (currentHash) => ({
          name: skill,
          sourcePath: join(source, skill),
          relativePath: skill,
          currentHash,
        })),
      ),
      lockFileEntries: [],
    });
    const cliUx = imported.skills.find((skill) => skill.name === "cli-ux");
    const skillCutter = imported.skills.find((skill) => skill.name === "skill-cutter");
    if (!cliUx || !skillCutter)
      return yield* Effect.die("Expected swyxio/skills to hold two Skills");
    const plan = yield* library.plan(
      {
        _tag: "Enabled",
        changes: [
          {
            _tag: "Enable",
            subject: { _tag: "Skill", id: cliUx.skill_id },
            where: [{ kind: "global" }, { kind: "repository", root: repository }],
          },
          {
            _tag: "Enable",
            subject: { _tag: "Skill", id: skillCutter.skill_id },
            where: [{ kind: "global" }],
          },
        ],
      },
      { base: yield* library.read },
    );
    const enabled = (yield* library.apply({ _tag: "Apply", plan })).result;
    if (enabled._tag !== "Applied")
      return yield* Effect.die("Expected the fixture to enable swyxio/skills");
  }).pipe(Effect.provide(layer));
  return {
    /** The fixture person's Library, routed as their installs. */
    layer,
    repository,
    /** Whether each installed copy is still in place. */
    installed: {
      globalCliUx: fs.exists(join(globalSkills, "cli-ux", "SKILL.md")),
      globalSkillCutter: fs.exists(join(globalSkills, "skill-cutter", "SKILL.md")),
    },
  };
});
