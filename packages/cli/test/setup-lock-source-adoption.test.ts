import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import {
  parseSkitSourceEffect,
  LibraryActor,
  LibraryAuditLog,
  LibraryStore,
  libraryStoreLayer,
  retainedTreePath,
  skitLayer,
  sourceLocator,
} from "@smolai/skit-core";
import { setupCommand } from "../src/handlers/library/setup.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { runSetup } from "../src/workflows/library/setup.js";
import { applySetupObservedCollections } from "../src/workflows/library/setup-observed-collections.js";
import {
  SetupLockMatch,
  type SetupOnboardingCandidate,
} from "../src/workflows/library/setup-contract.js";
import { resolveSkillsShSelectedSource } from "../src/workflows/library/skills-sh-lock-source.js";
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
    const observed = yield* home.owned(
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
      }).pipe(Effect.provide(interaction.layer)),
    );

    expect(observed.machineConfig.repositoryRoots).toEqual([]);
    expect(observed.repositories).toEqual([]);
    expect(yield* interaction.prompts).toEqual([]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("imports an approved skills.sh Collection without repeated broad observations", () =>
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
    yield* fs.writeFileString(
      join(repository, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          review: {
            source: "wellknown/skills.example",
            sourceType: "well-known",
            sourceUrl: "https://skills.example",
            computedHash: projectHash(text),
          },
        },
      }),
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
          cwd: root,
          interactive: true,
          dryRun: false,
          workDirFlag: root,
          localCustody: { acquisition: home.addOptions, bindings: home.bindings },
        }).pipe(Effect.provide(interaction.layer)),
      ),
    );
    expect(
      (yield* interaction.events).flatMap((event) =>
        event._tag === "StatusStarted" ? [event.message] : [],
      ),
    ).toEqual([
      "Observing local skills",
      "Observing local skills",
      "Revalidating the approved setup plan",
      "Importing 1 installed Collection (1 Skill)",
      "Verifying the completed setup",
    ]);
    const state = yield* Effect.flatMap(LibraryStore, (store) => store.inspect).pipe(
      Effect.provide(libraryStoreLayer({ home: home.home })),
    );
    expect(state.present).toBe(true);
    if (!state.present) return;
    const saved = state.state.collections[0];
    expect(
      state.state.skills
        .filter((skill) => skill.collection_id === saved?.collection_id)
        .map((skill) => skill.name),
    ).toEqual(["review"]);
  }).pipe(Effect.provide(skitLayer)),
);

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
            wellKnownDigest: `sha256:${createHash("sha256").update(installedText).digest("hex")}`,
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
    const adopted = yield* home.owned(
      writingTo(
        home.home,
        applySetupObservedCollections(
          { setup, retention: { originalsPath: home.originals } },
          preview,
          [{ name: candidate.name, paths: candidate.paths, groupKey: candidate.groupKey }],
        ),
      ).pipe(Effect.provideService(LibraryActor, "setup")),
    );
    expect(adopted.retained).toHaveLength(1);
    const history = yield* home.owned(Effect.flatMap(LibraryAuditLog, (audit) => audit.list()));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ type: "collection.retained", workflow: "setup" });
    expect(history[0]?.changes.map((change) => `${change.entity}:${change.action}`)).toEqual([
      "collection:added",
      "skill:added",
    ]);
    const retained = adopted.retained[0]!;
    const persisted = yield* Effect.flatMap(LibraryStore, (store) => store.inspect).pipe(
      Effect.provide(libraryStoreLayer({ home: home.home })),
    );
    expect(persisted.present).toBe(true);
    if (!persisted.present) return;
    const acquisition = persisted.state.acquisitions[0]!;
    expect(acquisition.input.value).toBe(`wellknown:${base}`);
    expect(acquisition.selection).toEqual({ kind: "selected-skills", names: ["review"] });
    expect(acquisition.observations).toEqual([
      expect.objectContaining({
        source_url: base,
        well_known_digest: expect.stringMatching(/^sha256:/),
        content_agreement: "agrees",
      }),
    ]);
    const skill = persisted.state.skills.find(
      (item) => item.collection_id === retained.collection_id,
    );
    expect(skill?.versions[0]?.origins).toEqual([
      expect.objectContaining({ acquisition_id: acquisition.acquisition_id }),
    ]);
    const tree = persisted.state.retained_copies[0]!;
    const original = retainedTreePath(home.originals, tree.digest);
    expect(yield* fs.readFileString(join(original, "review", "SKILL.md"))).toBe(installedText);
    expect(yield* fs.exists(join(original, "README.md"))).toBe(false);
    const secondSetup = yield* home.owned(runSetup(setup));
    expect(
      secondSetup.onboarding.candidates.some(
        (item) => item.action === "import-observed-collection" && item.name === "review",
      ),
    ).toBe(false);

    const reloaded = yield* Effect.flatMap(LibraryStore, (store) => store.inspect).pipe(
      Effect.provide(libraryStoreLayer({ home: home.home })),
    );
    expect(reloaded.present).toBe(true);
    if (!reloaded.present) return;
    expect(reloaded.state.skills[0]?.versions).toHaveLength(1);
    expect(reloaded.state.acquisitions[0]?.input.value).toContain(base);
    yield* fs.writeFileString(join(repository, "skills-lock.json"), "changed lock snapshot\n");
    const stale = yield* Effect.result(
      home.owned(
        writingTo(
          home.home,
          applySetupObservedCollections(
            { setup, retention: { originalsPath: home.originals } },
            preview,
            [{ name: candidate.name, paths: candidate.paths, groupKey: candidate.groupKey }],
          ),
        ),
      ),
    );
    expect(stale).toMatchObject({
      _tag: "Failure",
      failure: { reason: "lock-changed" },
    });
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
            wellKnownDigest: `sha256:${"1".repeat(64)}`,
          },
        },
      }),
    );
    const home = yield* libraryHome({ home: join(root, "home"), inventoryHome: root });
    const observed = yield* home.owned(
      runSetup({
        libraryHome: home.home,
        repositoryRoots: [],
        persistRoots: false,
        probePath: "",
        skillsStateHome: join(root, "state"),
        inventory: home.inventory,
      }),
    );
    expect(observed.locks).toEqual([
      expect.objectContaining({
        scope: "global",
        status: "valid",
        entries: [
          expect.objectContaining({
            sourceBaseUrl: "https://skills.example",
            wellKnownDigest: `sha256:${"1".repeat(64)}`,
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
        wellKnownDigest: `sha256:${"1".repeat(64)}`,
        originalEntry: { source: "wellknown/skills.example", sourceType: "well-known" },
      },
    });
    const selected = resolveSkillsShSelectedSource([{ lock, name: "review" }]);
    expect(selected).toEqual({
      _tag: "Resolved",
      source: {
        type: "well-known",
        ref: "https://skills.example",
        members: ["review"],
      },
    });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("turns selected GitHub lock paths into a reparsable Git Source", () =>
  Effect.gen(function* () {
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
    const resolution = resolveSkillsShSelectedSource([{ lock, name: "review" }]);
    const source = resolution._tag === "Resolved" ? resolution.source : undefined;
    expect(source?.type).toBe("git");
    if (!source) return;
    const locator = sourceLocator(source);
    expect(locator).toContain("ref=main");
    expect(locator).toContain("skill=skills%2Freview%2FSKILL.md");
    expect(yield* parseSkitSourceEffect(locator)).toEqual(source);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("adopts a selected member from a two-Skill GitHub lock collection", () =>
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
    const adopted = yield* home.owned(
      writingTo(
        home.home,
        applySetupObservedCollections(
          { setup, retention: { originalsPath: home.originals } },
          preview,
          [{ name: selected.name, paths: selected.paths, groupKey: selected.groupKey }],
        ),
      ),
    );
    expect(adopted.retained).toHaveLength(1);
    const retained = adopted.retained[0];
    if (!retained) return;
    const saved = yield* Effect.flatMap(LibraryStore, (store) => store.inspect).pipe(
      Effect.provide(libraryStoreLayer({ home: home.home })),
    );
    expect(saved.present).toBe(true);
    if (!saved.present) return;
    expect(
      saved.state.skills
        .filter((skill) => skill.collection_id === retained.collection_id)
        .map((skill) => skill.name),
    ).toEqual(["review"]);
    expect(saved.state.acquisitions[0]?.selection).toEqual({
      kind: "selected-paths",
      paths: ["skills/review/SKILL.md"],
    });
    expect(saved.state.acquisitions[0]?.observations).toHaveLength(1);
    expect(saved.state.acquisitions[0]?.observations[0]?.source).toBe("acme/skills");
    const secondSetup = yield* home.owned(runSetup(setup));
    expect(
      secondSetup.onboarding.candidates
        .filter((candidate) => candidate.action === "import-observed-collection")
        .map((candidate) => candidate.name),
    ).toEqual(["tdd"]);
  }).pipe(Effect.provide(skitLayer)),
);
