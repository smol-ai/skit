import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, FileSystem, Ref } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { libraryStoreLayer, LibraryStore, skitLayer, type LibraryState } from "@smolai/skit-core";
import { runSetup } from "../src/workflows/library/setup.js";
import { applySetupObservedCollections } from "../src/workflows/library/setup-observed-collections.js";
import { checkSubjectsEffect } from "../src/workflows/library/check.js";
import { libraryHome, scratch, writingTo } from "./helpers/library-home.js";

const hash = (text: string) => createHash("sha256").update("SKILL.md").update(text).digest("hex");

it.effect("checks a standalone skills.sh Skill against its recorded Git source", () =>
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
    const member = saved.state.skills[0]!;
    const { collection_id: _collectionId, ...memberFields } = member;
    const standalone = {
      ...memberFields,
      upstream: {
        source_identity: {
          kind: "well-known" as const,
          locator: { value: "https://skills.example.test" },
        },
        tracking: { kind: "default" as const },
        selection: { kind: "selected-skills" as const, names: [member.name] },
        last_acquisition_id: saved.state.acquisitions[0]!.acquisition_id,
      },
    };
    const localState = {
      ...saved.state,
      collections: [],
      skills: [standalone],
      acquisitions: saved.state.acquisitions.map((acquisition) => ({
        ...acquisition,
        observations: acquisition.observations.map((observation) => ({
          ...observation,
          source_type: "github",
          source_url: upstream,
        })),
      })),
    };
    const published = yield* Ref.make<LibraryState | undefined>(undefined);
    const discoveryClient = HttpClient.make((request) => {
      const digest = `sha256:${createHash("sha256").update(original).digest("hex")}`;
      const body = request.url.endsWith("/.well-known/agent-skills/index.json")
        ? JSON.stringify({
            $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
            skills: [
              {
                name: "review",
                description: "Review.",
                type: "skill-md",
                url: "/review/SKILL.md",
                digest,
              },
            ],
          })
        : request.url.endsWith("/review/SKILL.md")
          ? original
          : "missing";
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, { status: body === "missing" ? 404 : 200 }),
        ),
      );
    });
    const checked = yield* checkSubjectsEffect(localState, {}, standalone.skill_id).pipe(
      Effect.provideService(LibraryStore, {
        load: Effect.succeed(localState),
        inspect: Effect.succeed({ present: true as const, state: localState }),
        publish: (next) => Ref.set(published, next),
        snapshot: Effect.succeed(undefined),
        recordChangesSince: () => Effect.void,
        home: home.home,
        originalsPath: home.originals,
      }),
      Effect.provideService(HttpClient.HttpClient, discoveryClient),
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
