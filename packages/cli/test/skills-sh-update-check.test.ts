import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, FileSystem, Ref } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { libraryStoreLayer, LibraryStore, skitLayer, type LibraryState } from "@smolai/skit-core";
import { runSetup } from "../src/workflows/library/setup.js";
import { applySetupObservedCollections } from "../src/workflows/library/setup-observed-collections.js";
import { checkCollectionsEffect } from "../src/workflows/library/check.js";
import { libraryHome, scratch, writingTo } from "./helpers/library-home.js";

const hash = (text: string) => createHash("sha256").update("SKILL.md").update(text).digest("hex");

it.effect("recovers a skills.sh lock baseline from Git history before reporting an update", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* scratch("skit-skills-sh-check-");
    const upstream = join(root, "upstream");
    const work = join(root, "work");
    const repository = join(work, "project");
    const installed = join(repository, ".agents", "skills", "review");
    const upstreamSkill = join(upstream, "skills", "review");
    yield* fs.makeDirectory(installed, { recursive: true });
    yield* fs.makeDirectory(upstreamSkill, { recursive: true });
    const runGit = (cwd: string, args: readonly string[]) =>
      spawner.exitCode(ChildProcess.make("git", [...args], { cwd }));
    expect(yield* runGit(upstream, ["init", "-q", "-b", "main"])).toBe(0);
    expect(yield* runGit(upstream, ["config", "user.email", "test@example.com"])).toBe(0);
    expect(yield* runGit(upstream, ["config", "user.name", "Test"])).toBe(0);
    const original = "---\nname: review\ndescription: Review.\n---\n\n# Original\n";
    const updated = "---\nname: review\ndescription: Review.\n---\n\n# Updated\n";
    yield* fs.writeFileString(join(upstreamSkill, "SKILL.md"), original);
    expect(yield* runGit(upstream, ["add", "skills/review/SKILL.md"])).toBe(0);
    expect(yield* runGit(upstream, ["commit", "-q", "-m", "original"])).toBe(0);
    yield* fs.writeFileString(join(upstreamSkill, "SKILL.md"), updated);
    expect(yield* runGit(upstream, ["commit", "-qam", "updated"])).toBe(0);

    yield* fs.writeFileString(join(installed, "SKILL.md"), original);
    yield* fs.makeDirectory(repository, { recursive: true });
    expect(yield* runGit(repository, ["init", "-q"])).toBe(0);
    yield* fs.writeFileString(
      join(repository, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          review: {
            source: "acme/skills",
            sourceType: "github",
            ref: "main",
            skillPath: "skills/review/SKILL.md",
            computedHash: hash(original),
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
      inventory: home.inventory,
    };
    const preview = yield* home.owned(runSetup(setup));
    const candidate = preview.onboarding.candidates.find(
      (item) => item.name === "review" && item.action === "import-observed-collection",
    );
    expect(candidate?.action).toBe("import-observed-collection");
    if (!candidate || candidate.action !== "import-observed-collection") return;
    yield* home.owned(
      writingTo(
        home.home,
        applySetupObservedCollections(
          { setup, retention: { originalsPath: home.originals } },
          preview,
          [{ name: candidate.name, paths: candidate.paths, groupKey: candidate.groupKey }],
        ),
      ),
    );
    const saved = yield* Effect.flatMap(LibraryStore, (store) => store.inspect).pipe(
      Effect.provide(libraryStoreLayer({ home: home.home })),
    );
    expect(saved.present).toBe(true);
    if (!saved.present) return;
    const collection = saved.state.collections[0]!;
    const localCollection = {
      ...collection,
      upstream: {
        ...collection.upstream!,
        source_identity: {
          kind: "git" as const,
          remote: { value: upstream },
          collection_root: "." as const,
        },
      },
    };
    const localState = {
      ...saved.state,
      collections: [localCollection],
      acquisitions: saved.state.acquisitions.map((acquisition) => ({
        ...acquisition,
        input: { value: upstream },
        source_identity: localCollection.upstream.source_identity,
      })),
    };
    const published = yield* Ref.make<LibraryState | undefined>(undefined);
    const checked = yield* checkCollectionsEffect(
      localState,
      {},
      localCollection.collection_id,
    ).pipe(
      Effect.provideService(LibraryStore, {
        load: Effect.succeed(localState),
        inspect: Effect.succeed({ present: true as const, state: localState }),
        publish: (next) => Ref.set(published, next),
        snapshot: Effect.succeed(undefined),
        recordChangesSince: () => Effect.void,
        home: home.home,
        originalsPath: home.originals,
      }),
    );
    expect(checked[0]?.skills_sh?.members).toEqual([
      expect.objectContaining({
        skill_name: "review",
        status: "update-available",
        baseline_commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        upstream_commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      }),
    ]);
    expect(checked[0]?.skills_sh?.members[0]?.baseline_commit).not.toBe(
      checked[0]?.skills_sh?.members[0]?.upstream_commit,
    );
    expect((yield* Ref.get(published))?.acquisitions[0]?.observations[0]).toMatchObject({
      upstream_baseline: {
        lock_hash_kind: "computedHash",
        verification: "lock+retained-bytes",
        search_scope: "ref-path-history",
      },
    });
  }).pipe(Effect.provide(skitLayer)),
);
