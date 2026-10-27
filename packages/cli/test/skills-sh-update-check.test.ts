import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, FileSystem, Ref } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { libraryStoreLayer, LibraryStore, skitLayer, type LibraryState } from "@smolai/skit-core";
import { runSetup } from "../src/workflows/library/setup.js";
import { importSetupCollections } from "../src/workflows/library/setup-import.js";
import { checkSkillsShSubject } from "../src/workflows/library/skills-sh-update-check.js";
import { librarySubjects } from "../src/workflows/library/subject-resolution.js";
import { checkSubjects } from "../src/workflows/library/check.js";
import { libraryHome, scratch, writingTo } from "./helpers/library-home.js";

const hash = (text: string) => createHash("sha256").update("SKILL.md").update(text).digest("hex");

it.effect("checks skills.sh status against real Git history without saving Library state", () =>
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
        importSetupCollections({ setup }, preview, [
          { name: candidate.name, paths: candidate.paths, groupKey: candidate.groupKey },
        ]),
      ),
    );
    const saved = yield* Effect.flatMap(LibraryStore, (store) => store.inspect).pipe(
      Effect.provide(libraryStoreLayer({ home: home.home })),
    );
    expect(saved.present).toBe(true);
    if (!saved.present) return;
    const member = saved.state.skills[0]!;
    const collection = {
      ...saved.state.collections[0]!,
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
      collections: [collection],
      skills: [member],
      acquisitions: saved.state.acquisitions.map((acquisition) => ({
        ...acquisition,
        observations: acquisition.observations.map((observation) => ({
          ...observation,
          source_type: "github",
          source_url: upstream,
        })),
      })),
    };
    const savedState = yield* Ref.make<LibraryState | undefined>(undefined);
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
    const store = {
      load: Effect.succeed(localState),
      inspect: Effect.succeed({ present: true as const, state: localState }),
      save: (next: LibraryState) => Ref.set(savedState, next),
      home: home.home,
      originalsPath: home.originals,
      statePath: home.statePath,
      variantsPath: home.variantsPath,
    };
    const checked = yield* checkSubjects(localState, member.skill_id).pipe(
      Effect.provideService(LibraryStore, store),
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
    const subject = librarySubjects(localState)[0]!;
    const acquisition = localState.acquisitions[0]!;
    const retainedCopy = localState.retained_copies[0]!;
    type Observation = LibraryState["acquisitions"][number]["observations"][number];
    const checkObservation = (change: Partial<Observation> = {}) =>
      checkSkillsShSubject(
        subject,
        {
          ...acquisition,
          observations: acquisition.observations.map((observation) => ({
            ...observation,
            ...change,
          })),
        },
        retainedCopy,
      ).pipe(Effect.provideService(LibraryStore, store));
    const originalCommit = checked[0]!.skills_sh!.members[0]!.baseline_commit!;
    const originalTree = checked[0]!.skills_sh!.members[0]!.baseline_tree!;
    expect((yield* checkObservation({ ref: originalCommit }))?.members[0]).toMatchObject({
      status: "current",
      baseline_commit: originalCommit,
      baseline_verification: "lock+retained-bytes",
    });
    const treeOnly = (yield* checkObservation({
      computed_hash: undefined,
      skill_folder_hash: originalTree,
    }))?.members[0];
    expect(treeOnly).toMatchObject({
      status: "unverifiable",
      hash_kind: "skillFolderHash",
      baseline_commit: originalCommit,
      baseline_verification: "lock-only",
      reason: "Git tree hash cannot verify retained filesystem bytes",
    });
    expect((yield* checkObservation({ computed_hash: "unknown" }))?.members[0]).toMatchObject({
      status: "differs-from-lock-and-upstream",
    });
    // The next check must fetch the existing mirror, rather than inspecting its old tip.
    yield* fs.writeFileString(join(upstreamSkill, "SKILL.md"), original);
    expect(yield* runGit(upstream, ["commit", "-qam", "restored"])).toBe(0);
    expect((yield* checkObservation({ computed_hash: "unknown" }))?.members[0]).toMatchObject({
      status: "lock-stale",
    });
    expect((yield* checkObservation())?.members[0]).toMatchObject({
      status: "current",
      baseline_verification: "lock+retained-bytes",
    });
    expect(yield* runGit(upstream, ["rm", "-q", "skills/review/SKILL.md"])).toBe(0);
    expect(yield* runGit(upstream, ["commit", "-qm", "removed"])).toBe(0);
    expect((yield* checkObservation())?.members[0]).toMatchObject({
      status: "removed-upstream",
      baseline_verification: "lock+retained-bytes",
    });
    expect((yield* checkObservation({ computed_hash: "unknown" }))?.members[0]).toMatchObject({
      status: "unverifiable",
      reason: "lock hash not found in searched ref history",
    });
    expect((yield* checkObservation({ ref: "missing-ref" }))?.members[0]).toMatchObject({
      status: "unverifiable",
      reason: "could not resolve ref missing-ref",
    });
    expect(
      (yield* checkObservation({ source_url: join(root, "missing-source") }))?.members[0],
    ).toMatchObject({
      status: "unverifiable",
      reason: "could not reach Git source",
    });
    // Checking only reports: the Library it read is left exactly as it was.
    expect(yield* Ref.get(savedState)).toBeUndefined();
  }).pipe(Effect.provide(skitLayer)),
);
