import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vitest";
import { skitLayer } from "@smolai/skit-core";
import { setupCommand } from "../src/handlers/library/setup.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { libraryHome, scratch, writingTo } from "./helpers/library-home.js";

const names = [
  "peon-ping-config",
  "peon-ping-log",
  "peon-ping-toggle",
  "peon-ping-use",
  "production-migration",
];

for (const scenario of [
  "global differing copies",
  "global identical copies",
  "global symlink aliases",
  "global differing symlink target",
  "same repository differing copies",
  "separate repositories differing copies",
] as const) {
  it.effect(`keeps discovered copies visible for ${scenario}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-hidden-copies-");
      const repositories = scenario.startsWith("global")
        ? []
        : scenario.startsWith("same")
          ? [join(root, "work", "one")]
          : [join(root, "work", "one"), join(root, "work", "two")];
      for (const repository of repositories) {
        yield* fs.makeDirectory(repository, { recursive: true });
        expect(
          yield* (yield* ChildProcessSpawner.ChildProcessSpawner).exitCode(
            ChildProcess.make("git", ["init", "-q"], { cwd: repository }),
          ),
        ).toBe(0);
      }
      const codexRoot = join(root, ".codex", "skills");
      const claudeRoot = join(root, ".claude", "skills");
      const home = yield* libraryHome({
        home: join(root, "library"),
        inventoryHome: root,
        roots: { codex: codexRoot, claude: claudeRoot },
      });
      const firstRoot = repositories.length
        ? join(repositories[0], ".claude", "skills")
        : claudeRoot;
      const secondRoot = repositories.length
        ? join(repositories.at(-1) ?? repositories[0], ".codex", "skills")
        : codexRoot;
      const writeSkill = (path: string, name: string, body: string) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path, { recursive: true });
          yield* fs.writeFileString(
            join(path, "SKILL.md"),
            `---\nname: ${name}\ndescription: Test skill\n---\n\n${body}\n`,
          );
        });
      yield* writeSkill(join(codexRoot, "control"), "control", "Control");
      for (const name of names) {
        const first = join(firstRoot, name);
        const second = join(secondRoot, name);
        yield* writeSkill(first, name, "First content");
        if (scenario === "global symlink aliases") {
          yield* fs.makeDirectory(secondRoot, { recursive: true });
          yield* fs.symlink(first, second);
        } else if (scenario === "global differing symlink target") {
          const source = join(root, "Work", "skills", name);
          yield* writeSkill(source, name, "Other content");
          yield* fs.makeDirectory(secondRoot, { recursive: true });
          yield* fs.symlink(source, second);
        } else {
          yield* writeSkill(
            second,
            name,
            scenario === "global identical copies" ? "First content" : "Other content",
          );
        }
      }
      const applyIndependent = scenario.startsWith("separate");
      const selectedName = names[4];
      const selectedPaths = yield* Effect.forEach(
        [join(firstRoot, selectedName), join(secondRoot, selectedName)],
        (path) => fs.realPath(path),
      );
      const interaction = yield* makeScriptedInteraction([
        ...(repositories.length ? [repositories] : []),
        applyIndependent ? selectedPaths.map((path) => `${selectedName}\0${path}`) : ["control"],
        applyIndependent,
      ]);
      const observed = yield* home.owned(
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
            ...(repositories.length ? { workDirFlag: join(root, "work") } : {}),
            localCustody: { acquisition: home.addOptions, bindings: home.bindings },
          }).pipe(Effect.provide(interaction.layer)),
        ),
      );
      const hidden =
        scenario === "global differing copies" ||
        scenario === "global differing symlink target" ||
        scenario === "same repository differing copies";
      const candidates = observed.onboarding.candidates.filter((item) => names.includes(item.name));
      expect(candidates).toHaveLength(scenario.startsWith("separate") ? 10 : 5);
      expect(candidates.every((item) => item.action === "blocked")).toBe(hidden);
      if (hidden)
        expect(
          candidates.every(
            (item) => item.action === "blocked" && item.reason === "divergent-copies",
          ),
        ).toBe(true);
      expect(observed.instances.filter((item) => names.includes(item.name))).toHaveLength(
        scenario === "global symlink aliases" ? 5 : 10,
      );
      const picker = (yield* interaction.prompts).find((prompt) =>
        prompt.message.startsWith("Manage discovered skills:"),
      );
      expect(picker).toBeDefined();
      const copies = picker?.choices.filter((choice) => names.includes(choice.label)) ?? [];
      expect(copies).toHaveLength(scenario === "global symlink aliases" ? 5 : 10);
      expect(copies.every((choice) => !choice.disabled)).toBe(true);
      if (hidden) {
        expect(copies.every((choice) => choice.selectExplicitly && !choice.selected)).toBe(true);
        for (const name of names) {
          const alternatives = copies.filter((choice) => choice.label === name);
          expect(new Set(alternatives.map((choice) => choice.group)).size).toBe(1);
          expect(new Set(alternatives.map((choice) => choice.exclusiveGroup)).size).toBe(1);
        }
      }
      if (scenario.startsWith("separate")) {
        for (const name of names) {
          const independent = copies.filter((choice) => choice.label === name);
          expect(independent.every((choice) => !choice.selectExplicitly && !choice.selected)).toBe(
            true,
          );
          expect(independent.every((choice) => choice.exclusiveGroup === undefined)).toBe(true);
        }
      }
      if (applyIndependent) {
        const state = yield* home.durable;
        expect(state.skills).toHaveLength(2);
        expect(state.skills.every((skill) => skill.name === selectedName)).toBe(true);
        expect(state.collections).toHaveLength(2);
        expect(state.projections).toHaveLength(0);
        expect(yield* fs.readFileString(join(selectedPaths[0], "SKILL.md"))).toContain(
          "First content",
        );
        expect(yield* fs.readFileString(join(selectedPaths[1], "SKILL.md"))).toContain(
          "Other content",
        );
      }
      expect(yield* interaction.remaining).toBe(0);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}
