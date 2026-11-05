import { createHash } from "node:crypto";
import { join } from "node:path";
import { Cause, Effect, Exit, FileSystem, Result } from "effect";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { skitLayer, MachineSettings, LinkStat } from "@smolai/skit-core";
import { setupCommand } from "../src/library/setup.js";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";
import {
  collectSetupEvidence,
  runSetup,
  revalidateSetupPlan,
} from "@smolai/skit-core/library/setup";

import { systemError } from "effect/PlatformError";
import { renderSetup } from "../src/library/setup/present.js";

import { libraryHome, scratch, writingTo } from "./helpers/library-home.js";

it.effect("preserves saved v1 discovery roots when plain setup imports a Collection", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* scratch("skit-discovery-roots-repro-");
    const installed = join(root, ".agents", "skills", "review");
    const state = join(root, "state", "skills");
    const savedRoot = join(root, "saved-projects");
    const text = "---\nname: review\ndescription: Review code.\n---\n\n# Review\n";
    yield* fs.makeDirectory(installed, { recursive: true });
    yield* fs.makeDirectory(state, { recursive: true });
    yield* fs.writeFileString(join(installed, "SKILL.md"), text);
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
            wellKnownHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
          },
        },
      }),
    );
    const home = yield* libraryHome({ home: join(root, "home"), inventoryHome: root });
    const machinePath = join(home.home, "machine.json");
    yield* fs.writeFileString(
      machinePath,
      JSON.stringify({ schemaVersion: 1, repositoryRoots: [savedRoot] }),
    );
    const options = {
      libraryHome: home.home,
      inventory: home.inventory,
      probePath: "",
      skillsStateHome: join(root, "state"),
    };
    const preview = yield* home.owned(
      runSetup({ ...options, repositoryRoots: [], persistRoots: false }),
    );
    const candidate = preview.onboarding.candidates.find(
      (item) => item.action === "import-observed-collection",
    );
    expect(candidate?.action).toBe("import-observed-collection");
    if (!candidate || candidate.action !== "import-observed-collection")
      // oxlint-disable-next-line skit/no-throw-in-effect -- This assertion guard fails the test and narrows the candidate.
      throw new Error("Expected import candidate");
    expect(JSON.parse(yield* fs.readFileString(machinePath)).repositoryRoots).toEqual([savedRoot]);
    expect(preview.machineConfig.machineId).toBeUndefined();
    expect(preview.repositories).toEqual([]);
    const interaction = yield* makeScriptedInteraction([[candidate.groupKey], true, false]);
    yield* home.owned(
      writingTo(
        home.home,
        setupCommand({
          options,
          interactive: true,
          dryRun: false,
          manageOptions: { installOptions: home.installOptions },
        }).pipe(Effect.provide(interaction.layer)),
      ),
    );
    expect((yield* home.durable).collections).toHaveLength(1);
    const persisted = JSON.parse(yield* fs.readFileString(machinePath));
    expect(persisted.machineId).toBeDefined();
    expect(persisted.discoveryRoots).toEqual([savedRoot]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("creating identity preserves V1 repository discovery until decisions are saved", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* scratch("skit-identity-discovery-");
    const projects = join(root, "projects");
    const repository = join(projects, "example");
    yield* fs.makeDirectory(join(repository, ".git"), { recursive: true });
    const home = yield* libraryHome({ home: join(root, "library"), inventoryHome: root });
    yield* fs.writeFileString(
      join(home.home, "machine.json"),
      JSON.stringify({
        schemaVersion: 1,
        repositoryRoots: [projects],
      }),
    );
    const options = {
      libraryHome: home.home,
      inventory: home.inventory,
      persistRoots: false,
      scanDecidedRepositories: true,
    };
    const before = yield* home.owned(collectSetupEvidence(options));
    expect(before.walk.repositories).toEqual([repository]);
    yield* MachineSettings.ensureIdentity(home.home);
    const after = yield* home.owned(collectSetupEvidence(options));
    expect(after.discovering).toBe(true);
    expect(after.walk.repositories).toEqual(before.walk.repositories);
    yield* MachineSettings.setRepositoryDecision(home.home, repository, "ignored");
    const decided = yield* home.owned(collectSetupEvidence(options));
    expect(decided.discovering).toBe(false);
    expect(decided.walk.repositories).toEqual([]);
  }).pipe(Effect.provide(skitLayer)),
);

const discoveryFixture = Effect.fn("Test.discoveryFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* scratch("skit-discovery-evidence-");
  const projects = join(root, "projects");
  yield* fs.makeDirectory(projects);
  const home = yield* libraryHome({ home: join(root, "library"), inventoryHome: root });
  return {
    fs,
    projects,
    home,
    options: {
      libraryHome: home.home,
      inventory: home.inventory,
      repositoryRoots: [projects],
      persistRoots: false,
      probePath: "",
    },
  };
});

it.effect("distinguishes absent optional roots from missing configured roots", () =>
  Effect.gen(function* () {
    const f = yield* discoveryFixture();
    const complete = yield* f.home.owned(runSetup(f.options));
    expect(complete.scan.complete).toBe(true);
    expect(complete.scan.issues).toBeUndefined();
    const missing = join(f.projects, "missing");
    const scan = yield* f.home.owned(runSetup({ ...f.options, repositoryRoots: [missing] }));
    expect(scan.scan.complete).toBe(false);
    expect(scan.scan.issues).toContainEqual({ path: missing, code: "MISSING_ROOT" });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("retains unreadable-root evidence and revokes the earlier complete review", () =>
  Effect.gen(function* () {
    const f = yield* discoveryFixture();
    const before = yield* f.home.owned(runSetup(f.options));
    const fs = {
      ...f.fs,
      readDirectory: (path: string) =>
        path === f.projects
          ? Effect.fail(
              systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readDirectory",
                pathOrDescriptor: path,
              }),
            )
          : f.fs.readDirectory(path),
    };
    const scan = yield* f.home
      .owned(runSetup(f.options))
      .pipe(Effect.provideService(FileSystem.FileSystem, fs));
    expect(scan.scan.complete).toBe(false);
    expect(scan.scan.issues).toEqual([{ path: f.projects, code: "UNREADABLE_PATH" }]);
    expect(renderSetup({ ...scan, actions: [], choices: [] })).toContain(
      `UNREADABLE_PATH · ${f.projects}`,
    );
    const review = yield* Effect.result(
      f.home
        .owned(revalidateSetupPlan(f.options, before.onboarding.planId))
        .pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    );
    expect(Result.isFailure(review) && review.failure._tag).toBe("SetupPlanStale");
  }).pipe(Effect.provide(skitLayer)),
);

for (const reason of ["PermissionDenied", "NotFound"] as const)
  it.effect(`retains child-stat ${reason} while preserving discovered siblings`, () =>
    Effect.gen(function* () {
      const f = yield* discoveryFixture();
      const good = join(f.projects, "good");
      const bad = join(f.projects, "bad");
      yield* f.fs.makeDirectory(join(good, ".git"), { recursive: true });
      yield* f.fs.makeDirectory(bad);
      const links = yield* LinkStat;
      const evidence = yield* f.home.owned(collectSetupEvidence(f.options)).pipe(
        Effect.provideService(LinkStat, {
          ...links,
          lstat: (path) =>
            path === bad
              ? Effect.fail(
                  systemError({
                    _tag: reason,
                    module: "FileSystem",
                    method: "lstat",
                    pathOrDescriptor: path,
                  }),
                )
              : links.lstat(path),
        }),
      );
      expect(evidence.walk.repositories).toEqual([good]);
      expect(evidence.walk.complete).toBe(false);
      expect(evidence.discoveryIssues).toContainEqual({
        path: bad,
        code: reason === "NotFound" ? "MISSING_PATH" : "UNREADABLE_PATH",
      });
    }).pipe(Effect.provide(skitLayer)),
  );

it.effect("propagates unexpected filesystem failures and defects", () =>
  Effect.gen(function* () {
    const f = yield* discoveryFixture();
    const unexpected = systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "readDirectory",
      pathOrDescriptor: f.projects,
    });
    const failure = yield* Effect.result(
      f.home.owned(collectSetupEvidence(f.options)).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          readDirectory: (path) =>
            path === f.projects ? Effect.fail(unexpected) : f.fs.readDirectory(path),
        }),
      ),
    );
    expect(Result.isFailure(failure) && failure.failure).toBe(unexpected);
    const defect = new Error("discovery defect");
    const exit = yield* Effect.exit(
      f.home.owned(collectSetupEvidence(f.options)).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          readDirectory: (path) =>
            path === f.projects ? Effect.die(defect) : f.fs.readDirectory(path),
        }),
      ),
    );
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect),
    ).toBe(true);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("marks unreadable optional harness roots incomplete", () =>
  Effect.gen(function* () {
    const f = yield* discoveryFixture();
    const harnessRoot = join(f.options.inventory.home, ".agents", "skills");
    const scan = yield* f.home.owned(runSetup(f.options)).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...f.fs,
        readDirectory: (path) =>
          path === harnessRoot
            ? Effect.fail(
                systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readDirectory",
                  pathOrDescriptor: path,
                }),
              )
            : f.fs.readDirectory(path),
      }),
    );
    expect(scan.scan.complete).toBe(false);
    expect(scan.scan.issues).toContainEqual({ path: harnessRoot, code: "UNREADABLE_PATH" });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("retains missing explicit collection and watched-repository evidence", () =>
  Effect.gen(function* () {
    const f = yield* discoveryFixture();
    yield* f.fs.makeDirectory(join(f.projects, ".git"));
    yield* f.fs.writeFileString(
      join(f.projects, "skit.config.json"),
      JSON.stringify({
        schema: "skit.config.v1",
        discovery: { exclude: [], collections: [{ path: "custom-skills" }] },
      }),
    );
    const evidence = yield* f.home.owned(collectSetupEvidence(f.options));
    expect(evidence.discoveryComplete).toBe(false);
    expect(evidence.discoveryIssues).toContainEqual({
      path: join(f.projects, "custom-skills"),
      code: "MISSING_ROOT",
    });
    yield* MachineSettings.ensureIdentity(f.home.home);
    yield* MachineSettings.setRepositoryDecision(f.home.home, f.projects, "watched");
    yield* f.fs.remove(join(f.projects, ".git"), { recursive: true });
    const watched = yield* f.home.owned(runSetup({ ...f.options, scanDecidedRepositories: true }));
    expect(watched.scan.complete).toBe(false);
    expect(watched.scan.missingRepositories).toContain(f.projects);
    expect(watched.scan.issues).toContainEqual({
      path: join(f.projects, ".git"),
      code: "MISSING_ROOT",
    });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("propagates discovery interruption", () =>
  Effect.gen(function* () {
    const f = yield* discoveryFixture();
    const exit = yield* Effect.exit(
      f.home.owned(collectSetupEvidence(f.options)).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          readDirectory: (path) =>
            path === f.projects ? Effect.interrupt : f.fs.readDirectory(path),
        }),
      ),
    );
    expect(Exit.hasInterrupts(exit)).toBe(true);
  }).pipe(Effect.provide(skitLayer)),
);
