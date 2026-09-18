import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import {
  inspectOwnershipMarkerEffect,
  portableManifestFromLocalStateEffect,
  retainedTreePath,
  skitLayer,
} from "@smolai/skit-core";
import { setupCommand } from "../src/handlers/library/setup.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { libraryHome, scratch, writingTo } from "./helpers/library-home.js";

const skillDocument = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${body}\n---\n\n# ${body}\n`;

it.effect("adds selected skills and takes custody only of eligible global copies", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* scratch("skit-setup-local-custody-");
    const codexRoot = join(root, "codex-skills");
    const managedSkill = join(codexRoot, "review");
    const managedText = skillDocument("review", "Review code");
    yield* fs.makeDirectory(managedSkill, { recursive: true });
    yield* fs.writeFileString(join(managedSkill, "SKILL.md"), managedText);

    const repository = join(root, "repository");
    const repositorySkill = join(repository, ".agents", "skills", "repo-only");
    yield* fs.makeDirectory(repositorySkill, { recursive: true });
    yield* fs.writeFileString(
      join(repositorySkill, "SKILL.md"),
      skillDocument("repo-only", "Repository skill"),
    );
    expect(
      yield* (yield* ChildProcessSpawner.ChildProcessSpawner).exitCode(
        ChildProcess.make("git", ["init", "-q"], { cwd: repository }),
      ),
    ).toBe(0);

    const home = yield* libraryHome({
      home: join(root, "home"),
      inventoryHome: root,
      roots: { codex: codexRoot },
    });
    const interaction = yield* makeScriptedInteraction([
      [repository],
      ["repo-only", "review"],
      true,
    ]);
    yield* home.owned(
      writingTo(
        home.home,
        setupCommand({
          options: {
            libraryHome: home.home,
            inventory: home.inventory,
            probePath: "",
            skillsStateHome: join(root, "state"),
          },
          cwd: root,
          interactive: true,
          dryRun: false,
          workDirFlag: root,
          localCustody: { acquisition: home.addOptions, bindings: home.bindings },
        }).pipe(Effect.provide(interaction.layer)),
      ),
    );

    const prompts = yield* interaction.prompts;
    expect(prompts.map((prompt) => prompt.kind)).toEqual(["multiselect", "multiselect", "confirm"]);
    expect(prompts[1]?.choices.map((choice) => choice.value)).toEqual(["repo-only", "review"]);
    expect(yield* interaction.remaining).toBe(0);

    const state = yield* home.durable;
    expect(state.global_bindings).toHaveLength(1);
    expect(state.global_bindings[0]).toMatchObject({
      harness: "codex",
      scope: { kind: "global" },
    });
    expect(state.collections).toHaveLength(2);
    expect(state.collections.every((collection) => collection.upstream === undefined)).toBe(true);
    expect(state.retained_copies).toHaveLength(2);
    expect(state.projections).toEqual([
      expect.objectContaining({ path: managedSkill, status: "installed" }),
    ]);
    const retainedDocuments = yield* Effect.forEach(state.retained_copies, (copy) =>
      fs.readFileString(join(retainedTreePath(home.originals, copy.digest), "SKILL.md")),
    );
    expect(retainedDocuments).toEqual(
      expect.arrayContaining([managedText, skillDocument("repo-only", "Repository skill")]),
    );
    expect(yield* fs.readFileString(join(managedSkill, "SKILL.md"))).toBe(managedText);
    expect((yield* inspectOwnershipMarkerEffect(managedSkill)).kind).toBe("valid");
    expect((yield* inspectOwnershipMarkerEffect(repositorySkill)).kind).toBe("absent");
    expect(yield* fs.readFileString(join(repositorySkill, "SKILL.md"))).toBe(
      skillDocument("repo-only", "Repository skill"),
    );
    expect((yield* portableManifestFromLocalStateEffect(state)).snapshot_digests).toEqual(
      state.retained_copies.map((copy) => copy.digest).sort(),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
