import { createHash } from "node:crypto";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vitest";
import {
  type Digest,
  deterministicTreeHashEffect,
  LibraryStore,
  LibraryState,
  libraryStoreLayer,
  makeAcquisitionId,
  makeCollectionId,
  makeMachineId,
  makeProjectionId,
  makeRetainedCopyId,
  makeSkillId,
  makeSkillVersionId,
  skitLayer,
} from "@smolai/skit-core";
import {
  classifySetupOnboarding,
  classifyObservedOwner,
  isSetupCandidateSelectedByDefault,
  computeSkillsLockCompatibleHash,
  readSetupMachineConfig,
  revalidateSetupPlan,
  runSetup,
  updateSetupRepositoryDecision,
  type SetupOptions,
} from "../src/workflows/library/setup.js";
import type { SetupSkillInstance } from "../src/workflows/library/setup-contract.js";

const skillDocument = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`;

const git = Effect.fn("Test.git")(function* (cwd: string, ...args: string[]) {
  return (yield* (yield* ChildProcessSpawner.ChildProcessSpawner).string(
    ChildProcess.make("git", args, { cwd }),
  )).trim();
});

const projectHash = (content: string) => {
  const hash = createHash("sha256");
  hash.update("SKILL.md");
  hash.update(content);
  return hash.digest("hex");
};

const setupInstance = (
  name: string,
  path: string,
  overrides: Partial<SetupSkillInstance> = {},
): SetupSkillInstance => ({
  name,
  path,
  aliases: [path],
  scope: "global",
  harnesses: ["codex"],
  owner: { kind: "unknown" },
  contentIdentity: {
    status: "none",
    observedHash: projectHash(name),
    libraryMatches: [],
  },
  git: { status: "outside-git" },
  locks: [],
  ...overrides,
});

const setupLock = (
  source: string,
  content: "agrees" | "mismatch" | "unverifiable",
  name: string,
) => ({
  scope: "global" as const,
  lockPath: `/locks/${source}`,
  lockVersion: 3,
  lockContentHash: `sha256:${"0".repeat(64)}`,
  content,
  entry: {
    name,
    source,
    sourceType: "github",
    skillPath: `skills/${name}/SKILL.md`,
    originalEntry: { source, sourceType: "github" },
  },
});

const observeSetup = (options: SetupOptions) =>
  runSetup(options).pipe(
    Effect.provide(libraryStoreLayer({ home: options.libraryHome }).pipe(Layer.provide(skitLayer))),
  );

const revalidateSetup = (options: SetupOptions, planId: Digest) =>
  revalidateSetupPlan(options, planId).pipe(
    Effect.provide(libraryStoreLayer({ home: options.libraryHome }).pipe(Layer.provide(skitLayer))),
  );

const fixture = Effect.fn("Test.setupFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-setup-" });
  const libraryHome = join(root, "library");
  const work = join(root, "work");
  const repository = join(work, "tools");
  const codex = join(root, "codex");
  const claude = join(root, "claude");
  const opencode = join(root, "opencode");
  const devin = join(root, "devin");
  yield* fs.makeDirectory(repository, { recursive: true });
  yield* fs.makeDirectory(codex, { recursive: true });
  yield* fs.makeDirectory(claude, { recursive: true });
  yield* fs.makeDirectory(opencode, { recursive: true });
  yield* fs.makeDirectory(devin, { recursive: true });
  yield* git(repository, "init", "-q", "--initial-branch=main");
  yield* git(repository, "config", "user.name", "Test");
  yield* git(repository, "config", "user.email", "test@example.invalid");
  const options: SetupOptions = {
    libraryHome,
    repositoryRoots: [work],
    persistRoots: false,
    probePath: "",
    skillsStateHome: join(root, "state"),
    machineDisplayName: "Test machine",
    inventory: {
      home: root,
      configHome: join(root, "config"),
      overrides: { codex, claude, opencode, devin: [devin] },
    },
  };
  return { fs, root, libraryHome, work, repository, codex, claude, options };
});

it.effect("persists repository roots only when requested and reuses the machine config", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const first = yield* observeSetup({ ...f.options, persistRoots: true });
    expect(first.machineConfig).toEqual({
      path: join(f.libraryHome, "machine.json"),
      machineId: expect.any(String),
      displayName: "Test machine",
      repositoryRoots: [f.work],
      repositoryDecisions: [],
      persisted: true,
    });
    const persisted = yield* readSetupMachineConfig(f.libraryHome);
    expect(persisted).toMatchObject({
      schemaVersion: 4,
      machineId: first.machineConfig.machineId,
      displayName: "Test machine",
      discoveryRoots: [f.work],
      repositories: [],
    });
    const second = yield* observeSetup({
      ...f.options,
      repositoryRoots: undefined,
      persistRoots: false,
    });
    expect(second.machineConfig.repositoryRoots).toEqual([f.work]);
    expect(second.machineConfig.machineId).toBe(first.machineConfig.machineId);
    expect(second.machineConfig.displayName).toBe("Test machine");
    expect(second.machineConfig.persisted).toBe(false);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("migrates the version-one machine config only when setup persists", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.makeDirectory(f.libraryHome, { recursive: true });
    yield* f.fs.writeFileString(
      join(f.libraryHome, "machine.json"),
      `${JSON.stringify({ schemaVersion: 1, repositoryRoots: [f.work] }, null, 2)}\n`,
    );

    const observed = yield* observeSetup({
      ...f.options,
      repositoryRoots: undefined,
      persistRoots: false,
    });
    expect(observed.machineConfig).toEqual({
      path: join(f.libraryHome, "machine.json"),
      repositoryRoots: [f.work],
      repositoryDecisions: [],
      persisted: false,
    });
    expect(JSON.parse(yield* f.fs.readFileString(join(f.libraryHome, "machine.json")))).toEqual({
      schemaVersion: 1,
      repositoryRoots: [f.work],
    });

    const migrated = yield* observeSetup({
      ...f.options,
      repositoryRoots: undefined,
      persistRoots: true,
    });
    expect(migrated.machineConfig).toMatchObject({
      machineId: expect.any(String),
      displayName: "Test machine",
      repositoryRoots: [f.work],
      persisted: true,
    });
    expect(JSON.parse(yield* f.fs.readFileString(join(f.libraryHome, "machine.json")))).toEqual({
      schemaVersion: 4,
      machineId: migrated.machineConfig.machineId,
      displayName: "Test machine",
      discoveryRoots: [f.work],
      repositories: [],
    });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("scans only repositories watched by machine configuration", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const ignored = join(f.work, "ignored");
    const watchedSkill = join(f.repository, ".agents", "skills", "visible");
    yield* f.fs.makeDirectory(watchedSkill, { recursive: true });
    yield* f.fs.writeFileString(join(watchedSkill, "SKILL.md"), skillDocument("visible"));
    yield* f.fs.makeDirectory(ignored, { recursive: true });
    yield* git(ignored, "init", "-q");
    yield* f.fs.makeDirectory(join(ignored, ".agents", "skills", "hidden"), { recursive: true });
    yield* f.fs.writeFileString(
      join(ignored, ".agents", "skills", "hidden", "SKILL.md"),
      skillDocument("hidden"),
    );
    yield* observeSetup({
      ...f.options,
      persistRoots: true,
      repositoryDecisions: [
        { path: f.repository, status: "watched" },
        { path: ignored, status: "ignored" },
      ],
    });

    const inventory = yield* observeSetup({
      ...f.options,
      repositoryRoots: undefined,
      persistRoots: false,
      scanDecidedRepositories: true,
    });
    expect(inventory.repositories.map((repository) => repository.path)).toEqual([f.repository]);
    expect(inventory.instances.some((instance) => instance.name === "hidden")).toBe(false);
    expect(inventory.machineConfig.repositoryDecisions).toEqual([
      { path: ignored, status: "ignored" },
      { path: f.repository, status: "watched" },
    ]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("watches, ignores, and forgets a repository decision", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* updateSetupRepositoryDecision(f.libraryHome, f.repository, "watched");
    expect(yield* readSetupMachineConfig(f.libraryHome)).toMatchObject({
      schemaVersion: 4,
      repositories: [{ path: f.repository, status: "watched" }],
    });
    yield* updateSetupRepositoryDecision(f.libraryHome, f.repository, "ignored");
    expect(yield* readSetupMachineConfig(f.libraryHome)).toMatchObject({
      repositories: [{ path: f.repository, status: "ignored" }],
    });
    yield* updateSetupRepositoryDecision(f.libraryHome, f.repository, undefined);
    expect(yield* readSetupMachineConfig(f.libraryHome)).toMatchObject({ repositories: [] });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("binds setup consent to current discovery evidence", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const skill = join(f.codex, "review");
    yield* f.fs.makeDirectory(skill, { recursive: true });
    yield* f.fs.writeFileString(join(skill, "SKILL.md"), skillDocument("review"));
    const preview = yield* observeSetup(f.options);

    const unchanged = yield* revalidateSetup(f.options, preview.onboarding.planId);
    expect(unchanged.onboarding.planId).toBe(preview.onboarding.planId);

    yield* f.fs.writeFileString(
      join(skill, "SKILL.md"),
      `${skillDocument("review")}\nChanged after preview.\n`,
    );
    const stale = yield* Effect.result(revalidateSetup(f.options, preview.onboarding.planId));
    expect(Result.isFailure(stale)).toBe(true);
    if (Result.isFailure(stale)) {
      expect(stale.failure._tag).toBe("SetupPlanStale");
      if (stale.failure._tag === "SetupPlanStale") {
        expect(stale.failure.approvedPlanId).toBe(preview.onboarding.planId);
        expect(stale.failure.currentPlanId).not.toBe(preview.onboarding.planId);
      }
    }
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("reports Git preservation and verifies a project skills.sh lock", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const tracked = join(f.repository, ".agents", "skills", "review");
    const ignored = join(f.repository, ".agents", "skills", "private");
    const suppressed = join(f.repository, ".tmp", "generated-skill");
    const review = skillDocument("review");
    yield* f.fs.makeDirectory(tracked, { recursive: true });
    yield* f.fs.makeDirectory(ignored, { recursive: true });
    yield* f.fs.makeDirectory(suppressed, { recursive: true });
    yield* f.fs.writeFileString(join(tracked, "SKILL.md"), review);
    yield* f.fs.writeFileString(join(ignored, "SKILL.md"), skillDocument("private"));
    yield* f.fs.writeFileString(join(suppressed, "SKILL.md"), skillDocument("generated"));
    yield* f.fs.writeFileString(
      join(f.repository, ".gitignore"),
      "/SKILL.md\n.agents/skills/private/\n.tmp/\n",
    );
    yield* f.fs.writeFileString(join(f.repository, "SKILL.md"), skillDocument("root-local"));
    yield* git(f.repository, "add", ".gitignore", ".agents/skills/review/SKILL.md");
    yield* git(f.repository, "commit", "-qm", "skills");
    yield* f.fs.writeFileString(
      join(f.repository, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          review: {
            source: "acme/tools",
            sourceType: "github",
            skillPath: ".agents/skills/review/SKILL.md",
            computedHash: projectHash(review),
            skillFolderHash: "legacy-review-hash",
            extension: { retained: true },
          },
        },
      }),
    );
    for (let index = 0; index < 20; index++)
      yield* f.fs.makeDirectory(join(f.repository, "packages", `package-${index}`, "src"), {
        recursive: true,
      });
    const observed = yield* observeSetup(f.options);
    const byName = new Map(observed.instances.map((instance) => [instance.name, instance]));
    expect(observed.scan).toEqual({
      complete: true,
      directoriesExamined: 2,
      repositorySearchDepth: 1,
    });
    expect(observed.repositories).toEqual([
      {
        path: f.repository,
        skills: ["private", "review", "root-local"],
        status: "undecided",
      },
    ]);
    expect(observed.repositoryConfigs).toEqual([]);
    expect(byName.get("review")?.git.status).toBe("committed");
    expect(byName.get("review")?.locks).toEqual([
      expect.objectContaining({
        scope: "project",
        content: "agrees",
        entry: expect.objectContaining({
          source: "acme/tools",
          computedHash: projectHash(review),
          skillFolderHash: "legacy-review-hash",
          originalEntry: expect.objectContaining({ extension: { retained: true } }),
        }),
      }),
    ]);
    const unreadableFile = join(tracked, "private.txt");
    yield* f.fs.writeFileString(unreadableFile, "private");
    const unreadableHash = yield* computeSkillsLockCompatibleHash(tracked, tracked).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...f.fs,
        readFile: (path) => {
          if (String(path) !== unreadableFile) return f.fs.readFile(path);
          return f.fs
            .chmod(path, 0o000)
            .pipe(
              Effect.andThen(f.fs.readFile(path)),
              Effect.ensuring(f.fs.chmod(path, 0o644).pipe(Effect.orDie)),
            );
        },
      }),
    );
    expect(unreadableHash).toBeUndefined();
    expect(byName.get("private")?.git.status).toBe("ignored");
    expect(byName.get("root-local")?.git.status).toBe("mixed");
    expect(byName.has("generated")).toBe(false);
    expect(observed.locks).toEqual([
      expect.objectContaining({ scope: "project", status: "valid", version: 1 }),
    ]);
    expect(observed.onboarding.candidates).toEqual([
      expect.objectContaining({
        name: "private",
        action: "repository-owned",
      }),
      expect.objectContaining({
        name: "review",
        action: "import-observed-collection",
        contentAgreement: "agrees",
        source: "acme/tools",
      }),
      expect.objectContaining({
        name: "root-local",
        action: "repository-owned",
      }),
    ]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("applies repository discovery exclusions and declared collection roots", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const fixtureSkill = join(f.repository, "test", "fixtures", "review");
    const declaredSkill = join(f.repository, "custom", "skills", "private");
    yield* f.fs.makeDirectory(fixtureSkill, { recursive: true });
    yield* f.fs.makeDirectory(declaredSkill, { recursive: true });
    yield* f.fs.writeFileString(join(fixtureSkill, "SKILL.md"), skillDocument("fixture-review"));
    yield* f.fs.writeFileString(join(declaredSkill, "SKILL.md"), skillDocument("private"));
    yield* f.fs.writeFileString(join(f.repository, ".gitignore"), "custom/skills/\n");
    yield* f.fs.writeFileString(
      join(f.repository, "skit.config.json"),
      JSON.stringify({
        schema: "skit.config.v1",
        discovery: {
          exclude: ["test/fixtures/**"],
          collections: [{ path: "custom/skills" }],
        },
      }),
    );
    yield* git(
      f.repository,
      "add",
      ".gitignore",
      "skit.config.json",
      "test/fixtures/review/SKILL.md",
    );
    yield* git(f.repository, "commit", "-qm", "configure discovery");

    const observed = yield* observeSetup(f.options);
    expect(observed.scan.complete).toBe(true);
    expect(observed.instances.map((instance) => instance.name)).toEqual(["private"]);
    expect(observed.instances[0]?.git.status).toBe("ignored");
    expect(observed.repositoryConfigs).toEqual([
      {
        repository: f.repository,
        path: join(f.repository, "skit.config.json"),
        status: "valid",
        schema: "skit.config.v1",
        exclude: ["test/fixtures/**"],
        collections: [{ path: "custom/skills" }],
      },
    ]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("reports unsafe repository discovery config instead of applying it", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.writeFileString(
      join(f.repository, "skit.config.json"),
      JSON.stringify({
        schema: "skit.config.v1",
        discovery: { exclude: ["../outside/**"], collections: [] },
      }),
    );

    const observed = yield* observeSetup(f.options);
    expect(observed.scan.complete).toBe(false);
    expect(observed.repositoryConfigs).toEqual([
      expect.objectContaining({ repository: f.repository, status: "malformed" }),
    ]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("plans equivalent loose projections and blocks divergent copies", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const codexReview = join(f.codex, "review");
    const claudeReview = join(f.claude, "review");
    const codexDivergent = join(f.codex, "divergent");
    const claudeDivergent = join(f.claude, "divergent");
    for (const path of [codexReview, claudeReview, codexDivergent, claudeDivergent])
      yield* f.fs.makeDirectory(path, { recursive: true });
    yield* f.fs.writeFileString(join(codexReview, "SKILL.md"), skillDocument("review"));
    yield* f.fs.writeFileString(join(claudeReview, "SKILL.md"), skillDocument("review"));
    yield* f.fs.writeFileString(join(codexDivergent, "SKILL.md"), skillDocument("divergent"));
    yield* f.fs.writeFileString(
      join(claudeDivergent, "SKILL.md"),
      `${skillDocument("divergent")}\nDifferent bytes\n`,
    );

    const observed = yield* observeSetup(f.options);
    const reviewPaths = yield* Effect.forEach([claudeReview, codexReview], (path) =>
      f.fs.realPath(path),
    );
    const divergentPaths = yield* Effect.forEach([claudeDivergent, codexDivergent], (path) =>
      f.fs.realPath(path),
    );
    expect(observed.onboarding.candidates).toEqual([
      {
        name: "divergent",
        paths: divergentPaths.sort(),
        owner: { kind: "unknown" },
        action: "blocked",
        reason: "divergent-copies",
      },
      {
        name: "review",
        paths: reviewPaths.sort(),
        owner: { kind: "unknown" },
        action: "manage-locally",
        sourceSelection: "required",
      },
    ]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("offers equivalent Codex native and shared-root installations for custody", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const source = join(f.root, ".codex", "skills", "shared");
    const target = join(f.root, ".agents", "skills", "shared");
    yield* f.fs.makeDirectory(source, { recursive: true });
    yield* f.fs.makeDirectory(target, { recursive: true });
    yield* f.fs.writeFileString(join(source, "SKILL.md"), skillDocument("shared"));
    yield* f.fs.writeFileString(join(target, "SKILL.md"), skillDocument("shared"));
    const physicalSource = yield* f.fs.realPath(source);
    const physicalTarget = yield* f.fs.realPath(target);

    const observed = yield* observeSetup({
      ...f.options,
      inventory: {
        home: f.root,
        configHome: join(f.root, ".config"),
        overrides: {},
      },
    });

    expect(
      observed.instances
        .filter((instance) => instance.name === "shared")
        .map((instance) => instance.path),
    ).toEqual([physicalTarget, physicalSource]);
    expect(
      observed.onboarding.candidates.find(
        (candidate) => candidate.name === "shared" && candidate.action === "manage-locally",
      ),
    ).toMatchObject({ paths: [physicalTarget, physicalSource], sourceSelection: "required" });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("keeps onboarding classifications conservative across conflicting evidence", () =>
  Effect.sync(() => {
    const hash = projectHash("shared");
    const collectionOne = makeCollectionId();
    const collectionTwo = makeCollectionId();
    const exactSkill = makeSkillId();
    const renamedSkill = makeSkillId();
    const sharedSkill = makeSkillId();
    const exactVersion = makeSkillVersionId();
    const renamedVersion = makeSkillVersionId();
    const sharedVersion = makeSkillVersionId();
    const candidates = classifySetupOnboarding([
      setupInstance("lock-mismatch", "/global/lock-mismatch-a", {
        contentIdentity: { status: "none", observedHash: hash, libraryMatches: [] },
        locks: [setupLock("acme/a", "agrees", "lock-ambiguous")],
      }),
      setupInstance("lock-mismatch", "/global/lock-mismatch-b", {
        contentIdentity: { status: "none", observedHash: hash, libraryMatches: [] },
        locks: [setupLock("acme/b", "mismatch", "lock-mismatch")],
      }),
      setupInstance("lock-ambiguous", "/global/lock-ambiguous-a", {
        contentIdentity: { status: "none", observedHash: hash, libraryMatches: [] },
        locks: [setupLock("acme/a", "agrees", "lock-ambiguous")],
      }),
      setupInstance("lock-ambiguous", "/global/lock-ambiguous-b", {
        contentIdentity: { status: "none", observedHash: hash, libraryMatches: [] },
        locks: [setupLock("acme/b", "agrees", "lock-mismatch")],
      }),
      setupInstance("lock-local-only", "/global/lock-local-only", {
        contentIdentity: { status: "none", observedHash: hash, libraryMatches: [] },
        locks: [
          {
            ...setupLock("../local-source", "agrees", "lock-local-only"),
            entry: {
              name: "lock-local-only",
              source: "../local-source",
              sourceType: "local",
              originalEntry: { source: "../local-source", sourceType: "local" },
            },
          },
        ],
      }),
      setupInstance("library-exact", "/global/library-exact", {
        contentIdentity: {
          status: "exact",
          observedHash: hash,
          libraryMatches: [
            {
              collectionId: collectionOne,
              skillId: exactSkill,
              skillVersionId: exactVersion,
              name: "library-exact",
            },
          ],
        },
      }),
      setupInstance("library-renamed", "/global/library-renamed", {
        contentIdentity: {
          status: "exact",
          observedHash: hash,
          libraryMatches: [
            {
              collectionId: collectionOne,
              skillId: renamedSkill,
              skillVersionId: renamedVersion,
              name: "original",
            },
          ],
        },
      }),
      setupInstance("library-ambiguous", "/global/library-ambiguous", {
        contentIdentity: {
          status: "ambiguous",
          observedHash: hash,
          libraryMatches: [
            {
              collectionId: collectionOne,
              skillId: sharedSkill,
              skillVersionId: sharedVersion,
              name: "skill",
            },
            {
              collectionId: collectionTwo,
              skillId: sharedSkill,
              skillVersionId: sharedVersion,
              name: "skill",
            },
          ],
        },
      }),
      setupInstance("invalid", "/global/invalid", { owner: { kind: "invalid-marker" } }),
      setupInstance("unhashable", "/global/unhashable", {
        contentIdentity: { status: "unhashable", libraryMatches: [] },
      }),
      setupInstance("standalone", "/loose/standalone", {
        scope: "standalone",
        harnesses: [],
      }),
      setupInstance("same-name", "/global/same-name"),
      setupInstance("same-name", "/repo/.agents/skills/same-name", {
        scope: "project",
        git: { status: "committed", repository: "/repo" },
      }),
    ]);

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "lock-mismatch",
          action: "blocked",
          reason: "contested-lock-claim",
        }),
        expect.objectContaining({
          name: "lock-ambiguous",
          action: "blocked",
          reason: "contested-lock-claim",
        }),
        expect.objectContaining({
          name: "lock-local-only",
          action: "manage-locally",
        }),
        expect.objectContaining({ name: "library-exact", action: "bind-existing-entry" }),
        expect.objectContaining({
          name: "library-renamed",
          action: "blocked",
          reason: "library-skill-name-mismatch",
        }),
        expect.objectContaining({ name: "library-ambiguous", reason: "ambiguous-library-match" }),
        expect.objectContaining({ name: "invalid", reason: "invalid-ownership-marker" }),
        expect.objectContaining({ name: "unhashable", reason: "content-unhashable" }),
        expect.objectContaining({ name: "standalone", action: "leave-alone" }),
        expect.objectContaining({
          name: "same-name",
          action: "manage-locally",
          paths: ["/global/same-name"],
        }),
        expect.objectContaining({
          name: "same-name",
          action: "repository-owned",
          paths: ["/repo/.agents/skills/same-name"],
        }),
      ]),
    );
  }),
);

it.effect("offers an eligible lock member when another member is blocked", () =>
  Effect.sync(() => {
    const candidates = classifySetupOnboarding([
      setupInstance("review", "/global/review", {
        locks: [setupLock("acme/a", "agrees", "review")],
      }),
      setupInstance("tdd", "/global/tdd", {
        owner: { kind: "invalid-marker" },
        locks: [setupLock("acme/a", "agrees", "tdd")],
      }),
    ]);
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "review",
          action: "import-observed-collection",
        }),
        expect.objectContaining({
          name: "tdd",
          action: "blocked",
          reason: "invalid-ownership-marker",
        }),
      ]),
    );
  }),
);

it.effect(
  "offers lock-evidence import even when the observed Skill already matches the Library",
  () =>
    Effect.sync(() => {
      const hash = projectHash("upstream");
      const upstreamCollectionId = makeCollectionId();
      const upstreamSkillId = makeSkillId();
      const upstreamSkillVersionId = makeSkillVersionId();
      const upstream = setupInstance("upstream", "/repo/upstream", {
        git: { status: "ignored", repository: "/repo" },
        contentIdentity: {
          status: "exact",
          observedHash: hash,
          libraryMatches: [
            {
              collectionId: upstreamCollectionId,
              skillId: upstreamSkillId,
              skillVersionId: upstreamSkillVersionId,
              name: "upstream",
            },
          ],
        },
        locks: [setupLock("asmartbear/asb-skills", "agrees", "upstream")],
      });
      const localCollectionId = makeCollectionId();
      const localSkillId = makeSkillId();
      const localSkillVersionId = makeSkillVersionId();
      const local = setupInstance("local", "/repo/local", {
        git: { status: "ignored", repository: "/repo" },
        owner: { kind: "repository", repository: "/repo" },
        contentIdentity: {
          status: "exact",
          observedHash: hash,
          libraryMatches: [
            {
              collectionId: localCollectionId,
              skillId: localSkillId,
              skillVersionId: localSkillVersionId,
              name: "local",
            },
          ],
        },
      });

      expect(classifySetupOnboarding([upstream])).toEqual([
        expect.objectContaining({
          name: "upstream",
          action: "import-observed-collection",
        }),
      ]);
      expect(classifySetupOnboarding([local])).toEqual([
        {
          name: "local",
          paths: ["/repo/local"],
          owner: { kind: "repository", repository: "/repo" },
          action: "repository-owned",
        },
      ]);
    }),
);

it.effect("matches an unresolvable lock to a retained Collection by canonical reference", () =>
  Effect.sync(() => {
    const collectionId = makeCollectionId();
    const skillId = makeSkillId();
    const skillVersionId = makeSkillVersionId();
    const machineId = makeMachineId();
    const locator = "https://skills.example.test";
    const retained = Schema.decodeUnknownSync(LibraryState)({
      schemaVersion: 4,
      collections: [
        {
          collection_id: collectionId,
          display_name: "Example skills",
          upstream: {
            source_identity: { kind: "well-known", locator: { value: locator } },
            tracking: { kind: "default" },
            selection: { kind: "full-tree" },
          },
        },
      ],
      skills: [],
      retained_copies: [],
      acquisitions: [],
      global_bindings: [],
      local_bindings: [],
      projections: [],
      tombstones: [],
      unmanaged: [],
      adoption_receipts: [],
    });
    const instance = setupInstance("Bad_Name", "/repo/Bad_Name", {
      git: { status: "ignored", repository: "/repo" },
      contentIdentity: {
        status: "exact",
        observedHash: projectHash("Bad_Name"),
        libraryMatches: [{ collectionId, skillId, skillVersionId, name: "Bad_Name" }],
      },
      locks: [
        {
          scope: "global",
          lockPath: "/locks/well-known",
          lockVersion: 3,
          lockContentHash: `sha256:${"0".repeat(64)}`,
          content: "agrees",
          entry: {
            name: "Bad_Name",
            source: locator,
            sourceType: "well-known",
            sourceBaseUrl: locator,
            originalEntry: { source: locator, sourceType: "well-known" },
          },
        },
      ],
    });

    expect(classifySetupOnboarding([instance], { library: retained, machineId })).toEqual([]);
    expect(classifySetupOnboarding([instance], { library: retained })).toEqual([]);
  }),
);

it.effect(
  "classifies Codex-owned installations from canonical paths without guessing authorship",
  () =>
    Effect.sync(() => {
      const home = "/home/test";
      expect(
        classifyObservedOwner({
          canonicalPath: "/home/test/.codex/skills/.system/chronicle",
          home,
          harnesses: ["codex"],
        }),
      ).toEqual({ kind: "harness", harness: "codex", source: "Codex system", bundled: true });
      expect(
        classifyObservedOwner({
          canonicalPath:
            "/home/test/.codex/plugins/cache/openai-bundled/example/1.0.0/skills/review",
          home,
          harnesses: ["codex"],
        }),
      ).toEqual({ kind: "harness", harness: "codex", source: "Codex bundled", bundled: true });
      expect(
        classifyObservedOwner({
          canonicalPath:
            "/home/test/.codex/plugins/cache/openai-curated-remote/example/1.0.0/skills/review",
          home,
          harnesses: ["codex"],
        }),
      ).toEqual({ kind: "harness", harness: "codex", source: "Codex curated", bundled: false });
      expect(
        classifyObservedOwner({
          canonicalPath: "/home/test/.codex/skills/user-installed",
          home,
          harnesses: ["codex"],
        }),
      ).toEqual({ kind: "unknown" });
      expect(isSetupCandidateSelectedByDefault({ kind: "unknown" })).toBe(true);
      expect(
        isSetupCandidateSelectedByDefault({
          kind: "harness",
          harness: "codex",
          source: "Codex curated",
          bundled: false,
        }),
      ).toBe(false);
      expect(
        isSetupCandidateSelectedByDefault({
          kind: "repository",
          repository: "/work/repository",
        }),
      ).toBe(false);
    }),
);

it.effect(
  "offers harness-owned candidates deselected and keeps unmanaged candidates selected",
  () =>
    Effect.sync(() => {
      const managed = setupInstance("managed", "/cache/managed", {
        owner: {
          kind: "harness",
          harness: "codex",
          source: "Codex curated",
          bundled: false,
        },
      });
      const unmanaged = setupInstance("local", "/global/local");
      expect(classifySetupOnboarding([managed, unmanaged])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "managed",
            action: "harness-owned",
            owner: expect.objectContaining({ kind: "harness" }),
          }),
          expect.objectContaining({
            name: "local",
            action: "manage-locally",
            owner: { kind: "unknown" },
          }),
        ]),
      );
    }),
);

it.effect("identifies a bound authored SKIT and joins it to its library projections", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const authoredSkill = join(f.repository, "skills", "council");
    const projectedSkill = join(f.codex, "council");
    const copiedSkill = join(f.claude, "council-copy");
    yield* f.fs.makeDirectory(authoredSkill, { recursive: true });
    yield* f.fs.makeDirectory(projectedSkill, { recursive: true });
    yield* f.fs.makeDirectory(copiedSkill, { recursive: true });
    yield* f.fs.writeFileString(join(authoredSkill, "SKILL.md"), skillDocument("council"));
    yield* f.fs.writeFileString(join(projectedSkill, "SKILL.md"), skillDocument("council"));
    yield* f.fs.writeFileString(join(copiedSkill, "SKILL.md"), skillDocument("council"));
    yield* f.fs.writeFileString(
      join(f.repository, "skit.json"),
      JSON.stringify({ slug: "skills", skills: [{ name: "council", path: "skills/council" }] }),
    );
    yield* f.fs.writeFileString(
      join(f.repository, "skit.remote.json"),
      JSON.stringify({
        schema: "skit.remote.v1",
        origin: "https://registry.test",
        namespace: "tim",
        skit: "skills",
      }),
    );
    yield* git(f.repository, "add", "skit.json", "skit.remote.json", "skills/council/SKILL.md");
    yield* git(f.repository, "commit", "-qm", "authored skit");

    const contentHash = yield* deterministicTreeHashEffect(projectedSkill);
    const collectionRef = "skit:https://registry.test/tim/skills";
    const collectionId = makeCollectionId();
    const versionId = makeRetainedCopyId();
    const skillVersionId = makeSkillVersionId();
    const skillId = makeSkillId();
    const acquisitionId = makeAcquisitionId();
    const machineId = makeMachineId();
    const projectionId = makeProjectionId();
    const orphanedSkill = join(f.codex, "orphaned");
    const orphanedProjectionId = makeProjectionId();
    const orphanedCollectionId = makeCollectionId();
    const orphanedSkillId = makeSkillId();
    const orphanedSkillVersionId = makeSkillVersionId();
    yield* f.fs.makeDirectory(orphanedSkill, { recursive: true });
    yield* f.fs.writeFileString(join(orphanedSkill, "SKILL.md"), skillDocument("orphaned"));
    yield* f.fs.writeFileString(
      join(orphanedSkill, ".skit-ownership.json"),
      JSON.stringify({
        schemaVersion: 2,
        projectionPolicyVersion: 1,
        projection_id: orphanedProjectionId,
        collection_id: orphanedCollectionId,
        skill_id: orphanedSkillId,
        skill_version_id: orphanedSkillVersionId,
        expected_digest: contentHash,
        harness: "codex",
      }),
    );
    const projectionMarker = JSON.stringify({
      schemaVersion: 2,
      projectionPolicyVersion: 1,
      projection_id: projectionId,
      collection_id: collectionId,
      skill_id: skillId,
      skill_version_id: skillVersionId,
      expected_digest: contentHash,
      harness: "codex",
    });
    yield* f.fs.writeFileString(join(projectedSkill, ".skit-ownership.json"), projectionMarker);
    yield* f.fs.writeFileString(join(copiedSkill, ".skit-ownership.json"), projectionMarker);
    const state = Schema.decodeUnknownSync(LibraryState)({
      schemaVersion: 4,
      collections: [
        {
          collection_id: collectionId,
          display_name: "tim/skills",
          upstream: {
            source_identity: {
              kind: "registry",
              authority: "https://registry.test",
              namespace: "tim",
              slug: "skills",
            },
            tracking: { kind: "default" },
            selection: { kind: "full-tree" },
            last_acquisition_id: acquisitionId,
          },
        },
      ],
      skills: [
        {
          skill_id: skillId,
          collection_id: collectionId,
          path: "skills/council",
          name: "council",
          selected_skill_version_id: skillVersionId,
          versions: [
            {
              skill_version_id: skillVersionId,
              source_digest: contentHash,
              artifact_digest: contentHash,
              validation_identity_digest: contentHash,
              materialization_profile: "declared-skit-skill/v1",
              origins: [{ acquisition_id: acquisitionId, source_path: "skills/council" }],
            },
          ],
        },
      ],
      retained_copies: [
        {
          retained_copy_id: versionId,
          digest: contentHash,
          copy_profile: "verbatim/v1",
          members: [
            {
              source_path: "skills/council",
              source_digest: contentHash,
              artifact_digest: contentHash,
              materialization_profile: "declared-skit-skill/v1",
            },
          ],
        },
      ],
      acquisitions: [
        {
          acquisition_id: acquisitionId,
          retained_copy_id: versionId,
          input: { value: "skit://registry.test/tim/skills" },
          source_identity: {
            kind: "registry",
            authority: "https://registry.test",
            namespace: "tim",
            slug: "skills",
          },
          tracking: { kind: "default" },
          selection: { kind: "full-tree" },
          acquired_at: "2026-01-01T00:00:00.000Z",
          machine_id: machineId,
          observations: [],
        },
      ],
      global_bindings: [
        {
          collection_id: collectionId,
          harness: "codex",
          scope: { kind: "global" },
          skills: [skillId],
        },
      ],
      local_bindings: [],
      projections: [
        {
          projection_id: projectionId,
          collection_id: collectionId,
          skill_id: skillId,
          skill_version_id: skillVersionId,
          harness: "codex",
          root: f.codex,
          path: projectedSkill,
          expected_digest: contentHash,
          status: "installed",
          projected_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      tombstones: [],
      unmanaged: [],
      adoption_receipts: [],
    });
    const observed = yield* Effect.gen(function* () {
      const store = yield* LibraryStore;
      yield* store.publish(state);
      return yield* runSetup(f.options);
    }).pipe(
      Effect.provide(libraryStoreLayer({ home: f.libraryHome }).pipe(Layer.provide(skitLayer))),
    );
    const authoredSkillRealPath = yield* f.fs.realPath(authoredSkill);

    expect(observed.authoredCollections).toEqual([
      {
        repository: f.repository,
        descriptorPath: join(f.repository, "skit.json"),
        remotePath: join(f.repository, "skit.remote.json"),
        collectionRef,
        origin: "https://registry.test",
        namespace: "tim",
        skit: "skills",
        collectionId,
        skills: [{ name: "council", path: authoredSkillRealPath }],
      },
    ]);
    expect(
      observed.instances.find((instance) => instance.path === authoredSkillRealPath)?.owner,
    ).toEqual({ kind: "authored", collectionRef, collectionId });
    expect(
      observed.instances.find((instance) => instance.path === authoredSkillRealPath)
        ?.contentIdentity,
    ).toEqual({
      status: "exact",
      observedHash: contentHash,
      libraryMatches: [{ collectionId, skillId, skillVersionId, name: "council" }],
    });
    expect(
      observed.instances.find((instance) => instance.aliases.includes(projectedSkill))?.owner,
    ).toEqual({
      kind: "skit",
      membership: {
        kind: "retained",
        projectionId,
        collectionId,
        skillId,
        skillVersionId,
        displayName: "tim/skills",
        source: "https://registry.test/tim/skills",
      },
    });
    expect(
      observed.instances.find((instance) => instance.aliases.includes(copiedSkill)),
    ).toMatchObject({ owner: { kind: "invalid-marker" } });
    expect(
      observed.instances.find((instance) => instance.aliases.includes(orphanedSkill))?.owner,
    ).toEqual({
      kind: "skit",
      membership: {
        kind: "missing-from-library",
        projectionId: orphanedProjectionId,
        collectionId: orphanedCollectionId,
        skillId: orphanedSkillId,
        skillVersionId: orphanedSkillVersionId,
      },
    });
    expect(observed.projections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collectionId,
          skillId,
          status: "current",
        }),
      ]),
    );
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("coalesces harness aliases and retains broken-link and malformed-lock evidence", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const skill = join(f.repository, "skills", "review");
    yield* f.fs.makeDirectory(skill, { recursive: true });
    yield* f.fs.writeFileString(join(skill, "SKILL.md"), skillDocument("review"));
    yield* f.fs.symlink(skill, join(f.codex, "review"));
    yield* f.fs.symlink("../missing", join(f.codex, "broken"));
    const globalLock = join(f.root, "state", "skills", ".skill-lock.json");
    yield* f.fs.makeDirectory(join(f.root, "state", "skills"), { recursive: true });
    yield* f.fs.writeFileString(globalLock, "not json");
    const observed = yield* observeSetup(f.options);
    const review = observed.instances.find((instance) => instance.name === "review");
    expect([...(review?.aliases ?? [])].sort()).toEqual([skill, join(f.codex, "review")].sort());
    expect(review?.scope).toBe("global");
    expect(review?.harnesses).toEqual(["codex"]);
    expect(observed.brokenLinks).toEqual([
      { path: join(f.codex, "broken"), target: "../missing", harnesses: ["codex"] },
    ]);
    expect(observed.locks).toEqual([
      { scope: "global", path: globalLock, status: "malformed", entries: [] },
    ]);
    expect(yield* f.fs.exists(join(f.libraryHome, "machine.json"))).toBe(false);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("examines only immediate children until a nested container is configured", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const container = join(f.work, "cloned");
    const nestedRepository = join(container, "nested-tools");
    const skill = join(nestedRepository, "skills", "nested-review");
    yield* f.fs.makeDirectory(skill, { recursive: true });
    yield* f.fs.writeFileString(join(skill, "SKILL.md"), skillDocument("nested-review"));
    yield* git(nestedRepository, "init", "-q", "--initial-branch=main");

    const shallow = yield* observeSetup(f.options);
    expect(shallow.instances.some((instance) => instance.name === "nested-review")).toBe(false);
    expect(shallow.repositories).toEqual([]);

    const configured = yield* observeSetup({
      ...f.options,
      repositoryRoots: [f.work, container],
    });
    expect(configured.instances).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "nested-review" })]),
    );
    expect(configured.repositories.map((repository) => repository.path)).toEqual([
      nestedRepository,
    ]);
    expect(configured.scan.repositorySearchDepth).toBe(1);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("reconciles current, missing, and orphaned SKIT projections without persisting", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const current = join(f.codex, "current");
    const missing = join(f.codex, "missing");
    const orphaned = join(f.codex, "orphaned");
    yield* f.fs.makeDirectory(current, { recursive: true });
    yield* f.fs.makeDirectory(orphaned, { recursive: true });
    yield* f.fs.writeFileString(join(current, "SKILL.md"), skillDocument("current"));
    yield* f.fs.writeFileString(join(orphaned, "SKILL.md"), skillDocument("orphaned"));
    const currentHash = yield* deterministicTreeHashEffect(current);
    const orphanedHash = yield* deterministicTreeHashEffect(orphaned);
    const collectionId = makeCollectionId();
    const versionId = makeRetainedCopyId();
    const currentVersionId = makeSkillVersionId();
    const missingVersionId = makeSkillVersionId();
    const currentSkillId = makeSkillId();
    const missingSkillId = makeSkillId();
    const acquisitionId = makeAcquisitionId();
    const machineId = makeMachineId();
    const currentProjectionId = makeProjectionId();
    const missingProjectionId = makeProjectionId();
    const orphanedProjectionId = makeProjectionId();
    const orphanedCollectionId = makeCollectionId();
    const orphanedSkillId = makeSkillId();
    const orphanedVersionId = makeSkillVersionId();
    const currentRef = currentSkillId;
    const missingRef = missingSkillId;
    yield* f.fs.writeFileString(
      join(current, ".skit-ownership.json"),
      JSON.stringify({
        schemaVersion: 2,
        projectionPolicyVersion: 1,
        projection_id: currentProjectionId,
        collection_id: collectionId,
        skill_id: currentRef,
        skill_version_id: currentVersionId,
        expected_digest: currentHash,
        harness: "codex",
      }),
    );
    yield* f.fs.writeFileString(
      join(orphaned, ".skit-ownership.json"),
      JSON.stringify({
        schemaVersion: 2,
        projectionPolicyVersion: 1,
        projection_id: orphanedProjectionId,
        collection_id: orphanedCollectionId,
        skill_id: orphanedSkillId,
        skill_version_id: orphanedVersionId,
        expected_digest: orphanedHash,
        harness: "codex",
      }),
    );
    const state = Schema.decodeUnknownSync(LibraryState)({
      schemaVersion: 4,
      collections: [
        {
          collection_id: collectionId,
          display_name: "test-collection",
        },
      ],
      skills: [
        {
          skill_id: currentSkillId,
          collection_id: collectionId,
          path: "current",
          name: "current",
          selected_skill_version_id: currentVersionId,
          versions: [
            {
              skill_version_id: currentVersionId,
              source_digest: currentHash,
              artifact_digest: currentHash,
              validation_identity_digest: currentHash,
              materialization_profile: "plain-skill/v1",
              origins: [{ acquisition_id: acquisitionId, source_path: "current" }],
            },
          ],
        },
        {
          skill_id: missingSkillId,
          collection_id: collectionId,
          path: "missing",
          name: "missing",
          selected_skill_version_id: missingVersionId,
          versions: [
            {
              skill_version_id: missingVersionId,
              source_digest: currentHash,
              artifact_digest: currentHash,
              validation_identity_digest: currentHash,
              materialization_profile: "plain-skill/v1",
              origins: [{ acquisition_id: acquisitionId, source_path: "missing" }],
            },
          ],
        },
      ],
      retained_copies: [
        {
          retained_copy_id: versionId,
          digest: currentHash,
          copy_profile: "verbatim/v1",
          members: [
            {
              source_path: "current",
              source_digest: currentHash,
              artifact_digest: currentHash,
              materialization_profile: "plain-skill/v1",
            },
            {
              source_path: "missing",
              source_digest: currentHash,
              artifact_digest: currentHash,
              materialization_profile: "plain-skill/v1",
            },
          ],
        },
      ],
      acquisitions: [
        {
          acquisition_id: acquisitionId,
          retained_copy_id: versionId,
          input: { value: "/source" },
          source_identity: { kind: "local", machine_id: machineId, path: { value: "/source" } },
          tracking: { kind: "default" },
          selection: { kind: "full-tree" },
          acquired_at: "2026-01-01T00:00:00.000Z",
          machine_id: machineId,
          observations: [],
        },
      ],
      global_bindings: [
        {
          collection_id: collectionId,
          harness: "codex",
          scope: { kind: "global" },
          skills: [currentSkillId, missingSkillId],
        },
      ],
      local_bindings: [],
      projections: [
        {
          projection_id: currentProjectionId,
          collection_id: collectionId,
          skill_id: currentSkillId,
          skill_version_id: currentVersionId,
          harness: "codex",
          root: f.codex,
          path: current,
          expected_digest: currentHash,
          status: "installed",
          projected_at: "2026-01-01T00:00:00.000Z",
        },
        {
          projection_id: missingProjectionId,
          collection_id: collectionId,
          skill_id: missingSkillId,
          skill_version_id: missingVersionId,
          harness: "codex",
          root: f.codex,
          path: missing,
          expected_digest: currentHash,
          status: "installed",
          projected_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      tombstones: [],
      unmanaged: [],
      adoption_receipts: [],
    });
    const observed = yield* Effect.gen(function* () {
      const store = yield* LibraryStore;
      yield* store.publish(state);
      return yield* runSetup(f.options);
    }).pipe(
      Effect.provide(libraryStoreLayer({ home: f.libraryHome }).pipe(Layer.provide(skitLayer))),
    );

    expect(observed.projections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skillId: currentRef, path: current, status: "current" }),
        expect.objectContaining({ skillId: missingRef, path: missing, status: "missing" }),
      ]),
    );
    expect(observed.instances.find((instance) => instance.name === "current")?.owner.kind).toBe(
      "skit",
    );
    expect(observed.instances.find((instance) => instance.name === "orphaned")?.owner.kind).toBe(
      "skit",
    );
    expect(yield* f.fs.exists(join(f.libraryHome, "machine.json"))).toBe(false);
  }).pipe(Effect.provide(skitLayer)),
);
