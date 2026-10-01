import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import {
  inspectOwnershipMarkerEffect,
  libraryManifestFromLocalStateEffect,
  retainedTreePath,
  skitLayer,
} from "@smolai/skit-core";
import { addLibrarySourceEffect } from "../src/workflows/library/add.js";
import { setupCommand } from "../src/handlers/library/setup.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { setupStepTitles } from "../src/presentation/setup-steps.js";
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
    expect(prompts[1]?.choices.find((choice) => choice.value === "repo-only")).toMatchObject({
      group: "Repository · ~/repository",
      selected: false,
    });
    expect(yield* interaction.remaining).toBe(0);
    const preview = prompts[1]?.choices.find((choice) => choice.value === "review")?.preview;
    expect(preview).toBeDefined();
    expect(yield* preview!()).toContain(managedText);
    expect(yield* preview!()).toContain("SKILL.md modified");
    yield* fs.remove(join(managedSkill, "SKILL.md"));
    expect(yield* preview!()).toContain("Content unavailable");
    yield* fs.writeFileString(join(managedSkill, "SKILL.md"), managedText);

    const state = yield* home.durable;
    expect(state.global_bindings).toHaveLength(1);
    expect(state.global_bindings[0]).toMatchObject({ scope: { kind: "global" } });
    expect(state.collections).toHaveLength(2);
    expect(state.collections.every((collection) => collection.upstream === undefined)).toBe(true);
    expect(state.skills.every((skill) => skill.collection_id !== undefined)).toBe(true);
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
    expect((yield* libraryManifestFromLocalStateEffect(state)).snapshot_digests).toEqual(
      state.retained_copies.map((copy) => copy.digest).sort(),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("adopts skills with empty directories and Finder metadata", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* scratch("skit-setup-incidental-files-");
    const codexRoot = join(root, "codex-skills");
    const authoredSkill = join(root, "authored", "ai-readme");
    const emptyDirectorySkill = join(codexRoot, "ai-readme");
    const finderMetadataSkill = join(codexRoot, "review");
    yield* fs.makeDirectory(join(authoredSkill, "references"), { recursive: true });
    yield* fs.makeDirectory(finderMetadataSkill, { recursive: true });
    const readmeDocument = skillDocument("ai-readme", "Write a README");
    const reviewDocument = skillDocument("review", "Review code");
    yield* fs.writeFileString(join(authoredSkill, "SKILL.md"), readmeDocument);
    yield* fs.writeFileString(join(finderMetadataSkill, "SKILL.md"), reviewDocument);
    yield* fs.writeFileString(join(finderMetadataSkill, ".DS_Store"), "Finder metadata");
    yield* fs.symlink(authoredSkill, emptyDirectorySkill);

    const home = yield* libraryHome({
      home: join(root, "home"),
      inventoryHome: root,
      roots: { codex: codexRoot },
    });
    const interaction = yield* makeScriptedInteraction([["ai-readme", "review"], true]);
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
          localCustody: { acquisition: home.addOptions, bindings: home.bindings },
        }).pipe(Effect.provide(interaction.layer)),
      ),
    );

    expect(yield* interaction.remaining).toBe(0);
    const state = yield* home.durable;
    expect(state.collections).toHaveLength(2);
    expect(state.projections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: emptyDirectorySkill, status: "installed" }),
        expect.objectContaining({ path: finderMetadataSkill, status: "installed" }),
      ]),
    );
    expect(state.projections).toHaveLength(2);
    const retained = yield* Effect.forEach(state.retained_copies, (copy) =>
      Effect.gen(function* () {
        const path = retainedTreePath(home.originals, copy.digest);
        return {
          document: yield* fs.readFileString(join(path, "SKILL.md")),
          entries: yield* fs.readDirectory(path),
        };
      }),
    );
    expect(retained).toEqual(
      expect.arrayContaining([
        { document: readmeDocument, entries: ["SKILL.md", "references"] },
        { document: reviewDocument, entries: [".DS_Store", "SKILL.md"] },
      ]),
    );
    expect((yield* inspectOwnershipMarkerEffect(emptyDirectorySkill)).kind).toBe("valid");
    expect((yield* inspectOwnershipMarkerEffect(finderMetadataSkill)).kind).toBe("valid");
    expect(yield* fs.readFileString(join(emptyDirectorySkill, "SKILL.md"))).toBe(readmeDocument);
    expect(yield* fs.readFileString(join(finderMetadataSkill, "SKILL.md"))).toBe(reviewDocument);
    expect(yield* fs.readDirectory(join(emptyDirectorySkill, "references"))).toEqual([]);
    expect(yield* fs.readFileString(join(finderMetadataSkill, ".DS_Store"))).toBe(
      "Finder metadata",
    );
    expect(yield* fs.readFileString(join(authoredSkill, "SKILL.md"))).toBe(readmeDocument);
    expect((yield* inspectOwnershipMarkerEffect(authoredSkill)).kind).toBe("absent");
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("keeps every conflicting Claude copy visible and adopts only the chosen copy", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* scratch("skit-setup-conflicting-copies-");
    const claude = join(root, ".claude", "skills");
    const codex = join(root, ".codex", "skills");
    const names = Array.from({ length: 5 }, (_, index) => `conflict-${index + 1}`);
    for (const name of names)
      for (const agent of [claude, codex]) {
        yield* fs.makeDirectory(join(agent, name), { recursive: true });
        yield* fs.writeFileString(
          join(agent, name, "SKILL.md"),
          skillDocument(name, agent === claude ? "Claude contents" : "Codex contents"),
        );
      }
    const source = join(root, "sources", "shared");
    yield* fs.makeDirectory(source, { recursive: true });
    yield* fs.writeFileString(join(source, "SKILL.md"), skillDocument("shared", "Shared source"));
    for (const agent of [claude, codex]) yield* fs.symlink(source, join(agent, "shared"));
    const home = yield* libraryHome({
      home: join(root, "library"),
      inventoryHome: root,
      roots: { claude, codex },
    });
    const chosenPath = yield* fs.realPath(join(claude, names[0]));
    const interaction = yield* makeScriptedInteraction([[`${names[0]}\0${chosenPath}`], true]);
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
          localCustody: { acquisition: home.addOptions, bindings: home.bindings },
        }).pipe(Effect.provide(interaction.layer)),
      ),
    );
    const picker = (yield* interaction.prompts)[0];
    expect(picker.choices).toHaveLength(11);
    const conflicts = picker.choices.filter((choice) => choice.label.startsWith("conflict-"));
    expect(conflicts).toHaveLength(10);
    expect(
      conflicts.every((choice) => !choice.selected && !choice.disabled && choice.selectExplicitly),
    ).toBe(true);
    expect(conflicts.filter((choice) => choice.hint?.includes("/.claude/skills/"))).toHaveLength(5);
    const sharedRows = picker.choices.filter((choice) => choice.label === "shared");
    expect(sharedRows).toHaveLength(1);
    expect(sharedRows[0].description).toBeUndefined();
    expect(sharedRows[0].detail).toBeUndefined();
    expect(yield* sharedRows[0].preview!()).toContain("Discoverable by Claude, Codex");
    expect(yield* sharedRows[0].preview!()).toContain("Link:");
    const codexPath = yield* fs.realPath(join(codex, names[0]));
    const codexPreview = conflicts.find(
      (choice) => choice.value === `${names[0]}\0${codexPath}`,
    )?.preview;
    expect(yield* codexPreview!()).toContain("Codex contents");
    expect((yield* home.durable).skills.map((skill) => skill.name)).toEqual([names[0]]);
    expect((yield* inspectOwnershipMarkerEffect(chosenPath)).kind).toBe("valid");
    for (const name of names) {
      expect(yield* fs.readFileString(join(codex, name, "SKILL.md"))).toBe(
        skillDocument(name, "Codex contents"),
      );
      expect((yield* inspectOwnershipMarkerEffect(join(codex, name))).kind).toBe("absent");
      if (name !== names[0])
        expect((yield* inspectOwnershipMarkerEffect(join(claude, name))).kind).toBe("absent");
    }
    expect(yield* fs.readFileString(join(source, "SKILL.md"))).toBe(
      skillDocument("shared", "Shared source"),
    );
    expect(
      (yield* interaction.steps).find((step) => step.title === setupStepTitles.confirm)?.body,
    ).toContain(`Authoritative copy: ${names[0]} · ${chosenPath}`);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("reconnects only the selected exact Library copy", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* scratch("skit-setup-exact-copy-");
    const source = join(root, "source", "review");
    const claude = join(root, ".claude", "skills");
    const codex = join(root, ".codex", "skills");
    for (const path of [source, join(claude, "review"), join(codex, "review")]) {
      yield* fs.makeDirectory(path, { recursive: true });
      yield* fs.writeFileString(join(path, "SKILL.md"), skillDocument("review", "Same content"));
    }
    const home = yield* libraryHome({
      home: join(root, "library"),
      inventoryHome: root,
      roots: { claude, codex },
    });
    const selected = yield* fs.realPath(join(claude, "review"));
    const interaction = yield* makeScriptedInteraction([[`review\0${selected}`], true]);
    yield* home.owned(
      writingTo(
        home.home,
        Effect.gen(function* () {
          yield* addLibrarySourceEffect(source);
          yield* setupCommand({
            options: {
              libraryHome: home.home,
              inventory: home.inventory,
              probePath: "",
              skillsStateHome: join(root, "state"),
            },
            cwd: root,
            interactive: true,
            dryRun: false,
            localCustody: { acquisition: home.addOptions, bindings: home.bindings },
          }).pipe(Effect.provide(interaction.layer));
        }),
      ),
    );
    expect((yield* inspectOwnershipMarkerEffect(join(claude, "review"))).kind).toBe("valid");
    expect((yield* inspectOwnershipMarkerEffect(join(codex, "review"))).kind).toBe("absent");
    expect((yield* home.durable).collections).toHaveLength(1);
    expect((yield* interaction.prompts)[0].choices).toHaveLength(2);
  }).pipe(Effect.provide(skitLayer)),
);
