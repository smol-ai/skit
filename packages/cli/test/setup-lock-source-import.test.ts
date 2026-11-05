import { Library } from "@smolai/skit-core/library";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { MachineSettings, collectionVersionPath, skitLayer } from "@smolai/skit-core";
import { setupCommand } from "../src/library/setup/command.js";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";
import { setupPrompts } from "../src/library/setup/setup-steps.js";
import {
  runSetup,
  setupImportRequests,
  SetupLockMatch,
  type SetupOnboardingCandidate,
  resolveSkillsShSelectedSource,
} from "@smolai/skit-core/library/setup";

import { applySetupSelections } from "./helpers/setup-apply.js";

import { libraryHome, scratch, writingTo } from "./helpers/library-home.js";

const skillDocument = (body: string) =>
  `---\nname: review\ndescription: Review code.\n---\n\n# ${body}\n`;

const projectHash = (text: string) =>
  createHash("sha256").update("SKILL.md").update(text).digest("hex");

it.effect("skips repository discovery unless --work-dir supplies a directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* scratch("skit-interactive-skip-repositories-");
    const repository = join(root, "project");
    yield* fs.makeDirectory(repository, { recursive: true });
    expect(
      yield* (yield* ChildProcessSpawner.ChildProcessSpawner).exitCode(
        ChildProcess.make("git", ["init", "-q"], { cwd: repository }),
      ),
    ).toBe(0);
    const home = yield* libraryHome({ home: join(root, "home"), inventoryHome: root });
    const interaction = yield* makeScriptedInteraction([]);
    const scan = yield* home.owned(
      setupCommand({
        options: {
          libraryHome: home.home,
          inventory: home.inventory,
          probePath: "",
          skillsStateHome: join(root, "state"),
        },
        interactive: true,
        dryRun: false,
      }).pipe(Effect.provide(interaction.layer)),
    );

    expect(scan.machineConfig.repositoryRoots).toEqual([]);
    expect(scan.repositories).toEqual([]);
    expect(yield* interaction.prompts).toEqual([]);
  }).pipe(Effect.provide(skitLayer)),
);

for (const skillCount of [1, 12]) {
  it.effect(
    `imports an approved ${skillCount}-member skills.sh Collection without per-skill prompts`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* scratch("skit-interactive-lock-import-");
        const repository = join(root, "project");
        const installed = join(repository, ".agents", "skills", "review");
        yield* fs.makeDirectory(installed, { recursive: true });
        expect(
          yield* (yield* ChildProcessSpawner.ChildProcessSpawner).exitCode(
            ChildProcess.make("git", ["init", "-q"], { cwd: repository }),
          ),
        ).toBe(0);
        const text = skillDocument("Approved bytes");
        yield* fs.writeFileString(join(installed, "SKILL.md"), text);
        const members = Array.from({ length: skillCount }, (_, index) =>
          index === 0 ? "review" : `skill-${index}`,
        );
        const lockEntries: Record<
          string,
          { source: string; sourceType: string; sourceUrl: string; computedHash: string }
        > = {};
        for (const name of members) {
          const path = join(repository, ".agents", "skills", name);
          const document = text.replace("name: review", `name: ${name}`);
          yield* fs.makeDirectory(path, { recursive: true });
          yield* fs.writeFileString(join(path, "SKILL.md"), document);
          lockEntries[name] = {
            source: "wellknown/skills.example",
            sourceType: "well-known",
            sourceUrl: "https://skills.example",
            computedHash: projectHash(document),
          };
        }
        yield* fs.writeFileString(
          join(repository, "skills-lock.json"),
          JSON.stringify({ version: 1, skills: lockEntries }),
        );
        const home = yield* libraryHome({ home: join(root, "home"), inventoryHome: root });
        const setup = {
          libraryHome: home.home,
          repositoryRoots: [root],
          persistRoots: true,
          probePath: "",
          skillsStateHome: join(root, "state"),
          inventory: home.inventory,
        };
        const preview = yield* home.owned(runSetup(setup));
        const candidate = preview.onboarding.candidates.find(
          (item) => item.name === "review" && item.action === "import-observed-collection",
        );
        expect(candidate?.action).toBe("import-observed-collection");
        if (!candidate || candidate.action !== "import-observed-collection") return;
        const interaction = yield* makeScriptedInteraction([
          [repository],
          [candidate.groupKey],
          true,
          false,
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
              interactive: true,
              dryRun: false,
              workDirFlag: root,
              manageOptions: { installOptions: home.installOptions },
            }).pipe(Effect.provide(interaction.layer)),
          ),
        );
        const sourcePicker = (yield* interaction.prompts).find(
          (prompt) => prompt.message === setupPrompts.collections,
        );
        expect(sourcePicker?.choices).toEqual([
          expect.objectContaining({
            label: "wellknown/skills.example",
            hint: `${skillCount} installed skill${skillCount === 1 ? "" : "s"}`,
            selected: true,
          }),
        ]);
        expect(
          (yield* interaction.prompts).some((prompt) => prompt.message === setupPrompts.skills),
        ).toBe(false);
        const state = yield* home.owned(Effect.flatMap(Library.Service, (library) => library.read));
        expect(state._tag).toBe("Present");
        if (state._tag !== "Present") return;
        const saved = state.state.collections[0];
        expect(
          state.state.skills
            .filter((skill) => skill.collection_id === saved?.collection_id)
            .map((skill) => skill.name)
            .sort(),
        ).toEqual([...members].sort());
      }).pipe(Effect.provide(skitLayer)),
  );
}

it.effect("retains a project lock claim beside raw Skill bytes without inferring a Source", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* scratch("skit-lock-adoption-");
    const work = join(root, "work");
    const repository = join(work, "project");
    const installed = join(repository, ".agents", "skills", "review");
    yield* fs.makeDirectory(installed, { recursive: true });
    expect(
      yield* (yield* ChildProcessSpawner.ChildProcessSpawner).exitCode(
        ChildProcess.make("git", ["init", "-q"], { cwd: repository }),
      ),
    ).toBe(0);
    const installedText = skillDocument("First version");
    yield* fs.writeFileString(join(installed, "SKILL.md"), installedText);
    const base = "https://skills.example";
    yield* fs.writeFileString(
      join(repository, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          review: {
            source: "wellknown/skills.example",
            sourceType: "well-known",
            sourceUrl: base,
            computedHash: projectHash(installedText),
            wellKnownHash: `sha256:${createHash("sha256").update(installedText).digest("hex")}`,
          },
        },
      }),
    );
    const home = yield* libraryHome({ home: join(root, "home"), inventoryHome: root });
    const setup = {
      libraryHome: home.home,
      repositoryRoots: [work],
      persistRoots: true,
      probePath: "",
      skillsStateHome: join(root, "state"),
      machineDisplayName: "Test machine",
      inventory: home.inventory,
    };
    const preview = yield* home.owned(runSetup(setup));
    const candidate = preview.onboarding.candidates.find(
      (item) => item.name === "review" && item.action === "import-observed-collection",
    );
    expect(candidate?.action).toBe("import-observed-collection");
    if (!candidate || candidate.action !== "import-observed-collection") return;
    const lockPath = join(repository, "skills-lock.json");
    const lockSnapshot = yield* fs.readFileString(lockPath);
    const machineId = yield* MachineSettings.ensureIdentity(home.home);
    for (const change of ["changed", "missing"] as const) {
      if (change === "changed") yield* fs.writeFileString(lockPath, "changed lock snapshot\n");
      else yield* fs.remove(lockPath);
      const stale = yield* Effect.result(
        setupImportRequests(
          preview,
          [{ name: candidate.name, paths: candidate.paths, groupKey: candidate.groupKey }],
          machineId,
          "2026-11-04T00:00:00.000Z",
        ),
      );
      expect(stale).toMatchObject({
        _tag: "Failure",
        failure: { reason: "lock-changed" },
      });
      expect(yield* fs.exists(join(home.home, "state.json"))).toBe(false);
      expect(yield* fs.exists(home.originals)).toBe(false);
      expect(yield* fs.readFileString(join(installed, "SKILL.md"))).toBe(installedText);
      yield* fs.writeFileString(lockPath, lockSnapshot);
    }
    yield* home.owned(
      writingTo(
        home.home,
        applySetupSelections(setup, preview, home.installOptions, {
          imports: [{ name: candidate.name, paths: candidate.paths, groupKey: candidate.groupKey }],
        }),
      ).pipe(Effect.annotateLogs({ "skit.library.workflow": "setup" })),
    );
    const history = yield* home.owned(
      Effect.flatMap(Library.Service, (owner) =>
        Effect.map(owner.history, (history) => history.events),
      ),
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ type: "collection.retained", workflow: "setup" });
    // One event for the whole setup: its operation record, the import, and the record marked done.
    expect(history[0]?.changes.map((change) => `${change.entity}:${change.action}`)).toEqual([
      "library:operation-Pending",
      "collection:added",
      "skill:added",
      "library:operation-Done",
    ]);
    const persisted = yield* home.owned(Effect.flatMap(Library.Service, (library) => library.read));
    expect(persisted._tag).toBe("Present");
    if (persisted._tag !== "Present") return;
    const sourceImport = persisted.state.imports[0]!;
    expect(sourceImport.input.value).toBe(`wellknown:${base}`);
    expect(sourceImport.kind).toBe("source");
    expect(sourceImport.lock_file_entries).toEqual([
      expect.objectContaining({
        source_url: base,
        well_known_hash: expect.stringMatching(/^sha256:/),
        content_agreement: "agrees",
      }),
    ]);
    const skill = persisted.state.skills.find((item) => item.name === "review");
    expect(sourceImport.collection_id).toBe(skill?.collection_id);
    const tree = persisted.state.collection_versions[0]!;
    const original = collectionVersionPath(home.originals, tree.hash);
    expect(yield* fs.readFileString(join(original, "review", "SKILL.md"))).toBe(installedText);
    expect(yield* fs.exists(join(original, "README.md"))).toBe(false);
    const secondSetup = yield* home.owned(runSetup(setup));
    expect(
      secondSetup.onboarding.candidates.some(
        (item) => item.action === "import-observed-collection" && item.name === "review",
      ),
    ).toBe(false);

    const reloaded = yield* home.owned(Effect.flatMap(Library.Service, (library) => library.read));
    expect(reloaded._tag).toBe("Present");
    if (reloaded._tag !== "Present") return;
    expect(reloaded.state.skills[0]?.versions).toHaveLength(1);
    expect(reloaded.state.imports[0]?.input.value).toContain(base);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("reads a global skills.sh well-known base URL and preserves its digest claim", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* scratch("skit-global-lock-");
    const installed = join(root, ".agents", "skills", "review");
    const state = join(root, "state", "skills");
    yield* fs.makeDirectory(installed, { recursive: true });
    yield* fs.makeDirectory(state, { recursive: true });
    yield* fs.writeFileString(join(installed, "SKILL.md"), skillDocument("Global version"));
    yield* fs.writeFileString(
      join(state, ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          review: {
            source: "wellknown/skills.example",
            sourceType: "well-known",
            sourceUrl: "https://skills.example/review/SKILL.md",
            sourceBaseUrl: "https://skills.example",
            wellKnownHash: `sha256:${"1".repeat(64)}`,
          },
        },
      }),
    );
    const home = yield* libraryHome({ home: join(root, "home"), inventoryHome: root });
    const scan = yield* home.owned(
      runSetup({
        libraryHome: home.home,
        repositoryRoots: [],
        persistRoots: false,
        probePath: "",
        skillsStateHome: join(root, "state"),
        inventory: home.inventory,
      }),
    );
    expect(scan.locks).toEqual([
      expect.objectContaining({
        scope: "global",
        status: "valid",
        entries: [
          expect.objectContaining({
            sourceBaseUrl: "https://skills.example",
            wellKnownHash: `sha256:${"1".repeat(64)}`,
          }),
        ],
      }),
    ]);
    const lock = Schema.decodeUnknownSync(SetupLockMatch)({
      scope: "global",
      lockPath: "/state/skills/.skill-lock.json",
      lockVersion: 3,
      lockContentHash: `sha256:${"0".repeat(64)}`,
      content: "unverifiable",
      entry: {
        name: "review",
        source: "wellknown/skills.example",
        sourceType: "well-known",
        sourceUrl: "https://skills.example/review/SKILL.md",
        sourceBaseUrl: "https://skills.example",
        wellKnownHash: `sha256:${"1".repeat(64)}`,
        originalEntry: { source: "wellknown/skills.example", sourceType: "well-known" },
      },
    });
    const selected = resolveSkillsShSelectedSource([{ lock, name: "review" }]);
    expect(selected).toEqual({
      _tag: "Resolved",
      source: {
        type: "well-known",
        origin: "https://skills.example",
        skillNames: ["review"],
      },
    });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("turns selected GitHub lock paths into a structured GitHub Source", () =>
  Effect.sync(() => {
    const lock = Schema.decodeUnknownSync(SetupLockMatch)({
      scope: "project",
      lockPath: "/project/skills-lock.json",
      lockVersion: 1,
      lockContentHash: `sha256:${"0".repeat(64)}`,
      content: "agrees",
      entry: {
        name: "review",
        source: "acme/skills",
        sourceType: "github",
        ref: "main",
        skillPath: "skills/review/SKILL.md",
        computedHash: "2".repeat(64),
        originalEntry: { source: "acme/skills", sourceType: "github" },
      },
    });
    expect(resolveSkillsShSelectedSource([{ lock, name: "review" }])).toEqual({
      _tag: "Resolved",
      source: {
        type: "github",
        owner: "acme",
        repository: "skills",
        ref: "main",
        skillDirectories: ["skills/review"],
      },
    });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("manages a selected member from a two-Skill GitHub lock collection", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* scratch("skit-github-lock-adoption-");
    const work = join(root, "work");
    const repository = join(work, "project");
    const members = ["review", "tdd"] as const;
    const skills: {
      [name: string]: {
        source: string;
        sourceType: string;
        ref: string;
        skillPath: string;
        computedHash: string;
      };
    } = {};
    for (const name of members) {
      const installed = join(repository, ".agents", "skills", name);
      yield* fs.makeDirectory(installed, { recursive: true });
      const text = `---\nname: ${name}\ndescription: ${name} Skill.\n---\n\n# ${name}\n`;
      yield* fs.writeFileString(join(installed, "SKILL.md"), text);
      skills[name] = {
        source: "acme/skills",
        sourceType: "github",
        ref: "main",
        skillPath: `skills/${name}/SKILL.md`,
        computedHash: projectHash(text),
      };
    }
    expect(
      yield* (yield* ChildProcessSpawner.ChildProcessSpawner).exitCode(
        ChildProcess.make("git", ["init", "-q"], { cwd: repository }),
      ),
    ).toBe(0);
    yield* fs.writeFileString(
      join(repository, "skills-lock.json"),
      JSON.stringify({ version: 1, skills }),
    );
    const home = yield* libraryHome({ home: join(root, "home"), inventoryHome: root });
    const setup = {
      libraryHome: home.home,
      repositoryRoots: [work],
      persistRoots: true,
      probePath: "",
      skillsStateHome: join(root, "state"),
      machineDisplayName: "Test machine",
      inventory: home.inventory,
    };
    const preview = yield* home.owned(runSetup(setup));
    const candidates = preview.onboarding.candidates.filter(
      (item): item is Extract<SetupOnboardingCandidate, { action: "import-observed-collection" }> =>
        item.action === "import-observed-collection" && members.some((name) => name === item.name),
    );
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.groupKey)).size).toBe(1);
    const selected = candidates.find((candidate) => candidate.name === "review");
    if (!selected) return;
    yield* home.owned(
      writingTo(
        home.home,
        applySetupSelections(setup, preview, home.installOptions, {
          imports: [{ name: selected.name, paths: selected.paths, groupKey: selected.groupKey }],
        }),
      ),
    );
    const saved = yield* home.owned(Effect.flatMap(Library.Service, (library) => library.read));
    expect(saved._tag).toBe("Present");
    if (saved._tag !== "Present") return;
    expect(saved.state.collections).toHaveLength(1);
    const collectionId = saved.state.collections[0]?.collection_id;
    expect(
      saved.state.skills
        .filter((skill) => skill.collection_id === collectionId)
        .map((skill) => skill.name),
    ).toEqual(["review"]);
    expect(saved.state.imports[0]?.collection_id).toBe(collectionId);
    expect(saved.state.imports[0]?.lock_file_entries).toHaveLength(1);
    expect(saved.state.imports[0]?.lock_file_entries[0]?.source).toBe("acme/skills");
    const secondSetup = yield* home.owned(runSetup(setup));
    expect(
      secondSetup.onboarding.candidates
        .filter((candidate) => candidate.action === "import-observed-collection")
        .map((candidate) => candidate.name),
    ).toEqual(["tdd"]);
  }).pipe(Effect.provide(skitLayer)),
);
