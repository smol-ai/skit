import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { skitLayer } from "../src/platform/layer.js";
import { skitConfigurationLayer } from "../src/platform/configuration.js";
import type { LibraryState } from "../src/library/library-state.js";
import * as Library from "../src/library/library.js";
import { runSetup, applySetupPlan } from "../src/library/setup.js";
import { libraryView, openLibraryView } from "../src/library/internal/session/library-view.js";
import { resolveSkitSource } from "../src/sources/resolve.js";
import type { SkitSource } from "../src/library/library-contracts.js";
import { inspectResolvedSource } from "../src/library/source-inspection.js";
import { testRoots } from "./helpers/library-store.js";

const inspectSource = Effect.fn("Test.inspectSource")(function* (source: SkitSource) {
  return yield* inspectResolvedSource(source, yield* resolveSkitSource(source));
}, Effect.scoped);

const hash = (text: string) => createHash("sha256").update("SKILL.md").update(text).digest("hex");

it.effect("checks skills.sh status against real Git history without saving Library state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-skills-sh-check-" });
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
    const home = join(root, "home");
    const inventory = {
      home: root,
      configHome: join(root, "config"),
      overrides: {
        codex: [join(root, "inventory", "codex")],
        "claude-code": [join(root, "inventory", "claude")],
        opencode: [join(root, "inventory", "opencode")],
        devin: [join(root, "inventory", "devin")],
      },
    };
    for (const paths of Object.values(inventory.overrides))
      for (const path of paths) yield* fs.makeDirectory(path, { recursive: true });
    yield* Effect.gen(function* () {
      const setup = {
        libraryHome: home,
        repositoryRoots: [work],
        persistRoots: true,
        probePath: "",
        skillsStateHome: join(root, "state"),
        inventory: inventory,
      };
      const preview = yield* runSetup(setup);
      const candidate = preview.onboarding.candidates.find(
        (item) => item.name === "review" && item.action === "import-observed-collection",
      );
      expect(candidate?.action).toBe("import-observed-collection");
      if (!candidate || candidate.action !== "import-observed-collection") return;
      yield* applySetupPlan(
        { manage: { installOptions: inventory }, withStatus: (_message, stage) => stage },
        {
          setup,
          planId: preview.onboarding.planId,
          persistRoots: false,
          imports: [{ name: candidate.name, paths: candidate.paths, groupKey: candidate.groupKey }],
          bindings: [],
          ownership: [],
          removals: { entries: [], folders: [] },
          changes: [],
        },
      );
      const saved = yield* Effect.flatMap(Library.Service, (library) => library.read);
      expect(saved._tag).toBe("Present");
      if (saved._tag !== "Present") return;
      const member = saved.state.skills[0]!;
      const view = yield* openLibraryView(home);
      expect(view.skillsShCollectionIds).toEqual([member.collection_id]);
      const collection = {
        ...saved.state.collections[0]!,
        upstream: {
          source_identity: {
            kind: "well-known" as const,
            locator: { value: "https://skills.example.test" },
          },
          tracking: { kind: "default" as const },
          selection: { kind: "selected-skills" as const, names: [member.name] },
          last_acquisition_id: saved.state.imports[0]!.import_id,
        },
      };
      const localState = {
        ...saved.state,
        collections: [collection],
        skills: [member],
        imports: saved.state.imports.map((sourceImport) => ({
          ...sourceImport,
          lock_file_entries: sourceImport.lock_file_entries.map((lockFileEntry) => ({
            ...lockFileEntry,
            source_type: "github",
            source_url: upstream,
          })),
        })),
      };
      const beforeState = yield* fs.readFileString(join(home, "state.json"));
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
      const checked = yield* libraryView(localState, join(home, "originals"))
        .checkSubjects(member.skill_id, {
          inspectSource,
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, discoveryClient));
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
      const sourceImport = localState.imports[0]!;
      const collectionVersion = localState.collection_versions[0]!;
      type Observation = LibraryState["imports"][number]["lock_file_entries"][number];
      const checkLockEntry = (change: Partial<Observation> = {}) => {
        const state = {
          ...localState,
          imports: [
            {
              ...sourceImport,
              lock_file_entries: sourceImport.lock_file_entries.map((lockFileEntry) => ({
                ...lockFileEntry,
                ...change,
              })),
            },
          ],
        };
        return libraryView(state, join(home, "originals"))
          .checkSubjects(member.skill_id, {
            inspectSource: () => Effect.succeed({ snapshot_digest: collectionVersion.hash }),
          })
          .pipe(Effect.map((rows) => rows[0]?.skills_sh));
      };
      const originalCommit = checked[0]!.skills_sh!.members[0]!.baseline_commit!;
      const originalTree = checked[0]!.skills_sh!.members[0]!.baseline_tree!;
      expect((yield* checkLockEntry({ ref: originalCommit }))?.members[0]).toMatchObject({
        status: "current",
        baseline_commit: originalCommit,
        baseline_verification: "lock+original-bytes",
      });
      const treeOnly = (yield* checkLockEntry({
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
      expect((yield* checkLockEntry({ computed_hash: "unknown" }))?.members[0]).toMatchObject({
        status: "differs-from-lock-and-upstream",
      });
      // The next check must fetch the existing mirror, rather than inspecting its old tip.
      yield* fs.writeFileString(join(upstreamSkill, "SKILL.md"), original);
      expect(yield* runGit(upstream, ["commit", "-qam", "restored"])).toBe(0);
      expect((yield* checkLockEntry({ computed_hash: "unknown" }))?.members[0]).toMatchObject({
        status: "lock-stale",
      });
      expect((yield* checkLockEntry())?.members[0]).toMatchObject({
        status: "current",
        baseline_verification: "lock+original-bytes",
      });
      expect(yield* runGit(upstream, ["rm", "-q", "skills/review/SKILL.md"])).toBe(0);
      expect(yield* runGit(upstream, ["commit", "-qm", "removed"])).toBe(0);
      expect((yield* checkLockEntry())?.members[0]).toMatchObject({
        status: "removed-upstream",
        baseline_verification: "lock+original-bytes",
      });
      expect((yield* checkLockEntry({ computed_hash: "unknown" }))?.members[0]).toMatchObject({
        status: "unverifiable",
        reason: "lock hash not found in searched ref history",
      });
      expect((yield* checkLockEntry({ ref: "missing-ref" }))?.members[0]).toMatchObject({
        status: "unverifiable",
        reason: "could not resolve ref missing-ref",
      });
      expect(
        (yield* checkLockEntry({ source_url: join(root, "missing-source") }))?.members[0],
      ).toMatchObject({
        status: "unverifiable",
        reason: "could not reach Git source",
      });
      // Checking only reports: the Library it read is left exactly as it was.
      expect(yield* fs.readFileString(join(home, "state.json"))).toBe(beforeState);
    }).pipe(
      Effect.provide(Library.layer({ home, roots: testRoots(home) })),
      Effect.provide(skitConfigurationLayer(home)),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
