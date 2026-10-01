import { ListResult } from "../src/workflows/library/list-contract.js";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import {
  deterministicTreeHashEffect,
  LibraryStore,
  skitLayer,
  retainAuthoredCollectionUnderLockEffect,
  type SkillsShObservation,
} from "@smolai/skit-core";
import {
  readLibrarySkillMetadata,
  skillModificationTime,
} from "../src/workflows/library/skill-metadata.js";
import { inventoryCommand } from "../src/handlers/library/inventory.js";
import { renderMachineSkills } from "../src/presentation/inventory.js";
import { renderLibraryList } from "../src/presentation/library-list.js";
import { presentListCommand } from "../src/handlers/library/list.js";
import { openLibrarySession } from "../src/workflows/library/session.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import {
  libraryHome,
  initializeLibraryMachine,
  retainObservedIn,
  writingTo,
} from "./helpers/library-home.js";

it.effect(
  "list modes report provenance of selected bytes rather than a newer upstream version",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-metadata-" });
      const home = yield* libraryHome({ home: join(root, "home") });
      yield* initializeLibraryMachine(home.home);
      const source = join(root, "review");
      yield* fs.makeDirectory(source);
      for (const [index, retainedAt] of [
        "2026-05-01T00:00:00.000Z",
        "2026-09-29T00:00:00.000Z",
      ].entries()) {
        yield* fs.writeFileString(join(source, "SKILL.md"), `Version ${index}\n`);
        yield* home.owned(
          writingTo(
            home.home,
            retainObservedIn(home.home)({
              source: { type: "github", owner: "example", repository: "skills" },
              revision: { kind: "commit", commit: String(index + 1).repeat(40) },
              input: "example/skills",
              retainedAt,
              skills: [
                {
                  name: "review",
                  sourcePath: source,
                  relativePath: "review",
                  observedHash: yield* deterministicTreeHashEffect(source),
                },
              ],
              observations: [],
            }),
          ),
        );
      }
      const state = yield* home.durable;
      const observation = (index: number): SkillsShObservation => ({
        type: "skills.sh-lock",
        machine_id: state.acquisitions[index]!.machine_id,
        observed_at: state.acquisitions[index]!.acquired_at,
        source_updated_at: index === 0 ? "2026-04-20T00:00:00.000Z" : "2026-09-25T00:00:00.000Z",
        lock_path: { value: "/fixture/skills-lock.json" },
        lock_version: 3,
        lock_scope: "global",
        lock_content_hash: `sha256:${"a".repeat(64)}`,
        source: "example/skills",
        source_type: "github",
        skill_name: "review",
        skill_path: "review",
        content_agreement: "agrees",
        original_entry_digest: `sha256:${"b".repeat(64)}`,
        original_entry: { source: "example/skills" },
      });
      const selected = {
        ...state,
        skills: state.skills.map((skill) => ({
          ...skill,
          local_version_id: skill.versions[0]!.skill_version_id,
        })),
        acquisitions: state.acquisitions.map((acquisition, index) => ({
          ...acquisition,
          observations: [observation(index)],
        })),
      };
      yield* home.owned(
        writingTo(
          home.home,
          LibraryStore.use((store) => store.publish(selected)),
        ),
      );
      const interaction = yield* makeScriptedInteraction([]);
      yield* home.owned(presentListCommand().pipe(Effect.provide(interaction.layer)));
      const listing = yield* Schema.decodeUnknownEffect(ListResult)(
        (yield* interaction.results)[0]!.data,
      );
      expect(listing).toMatchObject({
        subjects: [
          {
            skills: [
              {
                source: "example/skills",
                revision: "1".repeat(40),
                source_updated_at: "2026-04-20T00:00:00.000Z",
                acquired_at: "2026-05-01T00:00:00.000Z",
              },
            ],
          },
        ],
      });
      const session = yield* home.owned(openLibrarySession());
      expect(session.skills[0]).toMatchObject({
        revision: "1".repeat(40),
        source_updated_at: "2026-04-20T00:00:00.000Z",
      });
      expect(renderLibraryList(listing)).toContain(
        "Source updated: 2026-04-20 · Acquired: 2026-05-01",
      );
      const unavailable = yield* readLibrarySkillMetadata(
        {
          ...selected,
          acquisitions: selected.acquisitions.map((acquisition) => ({
            ...acquisition,
            observations: [{ ...observation(0), content_agreement: "mismatch" }],
          })),
        },
        home.originals,
      );
      expect(unavailable.get(state.skills[0]!.skill_id)?.source_updated_at).toBeNull();
      const conflicting = yield* readLibrarySkillMetadata(
        {
          ...selected,
          acquisitions: selected.acquisitions.map((acquisition) => ({
            ...acquisition,
            observations: [
              observation(0),
              { ...observation(0), source_updated_at: "2026-04-21T00:00:00.000Z" },
            ],
          })),
        },
        home.originals,
      );
      expect(conflicting.get(state.skills[0]!.skill_id)?.source_updated_at).toBeNull();
      expect(yield* home.durable).toEqual(selected);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("inventory distinguishes physical copy dates and follows symlink target dates", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-inventory-dates-" });
    const codex = join(root, "codex");
    const claude = join(root, "claude");
    const first = join(codex, "review");
    const second = join(claude, "review");
    const alias = join(claude, "linked-review");
    for (const [path, date] of [
      [first, "2026-01-03T00:00:00.000Z"],
      [second, "2026-09-20T00:00:00.000Z"],
    ]) {
      yield* fs.makeDirectory(path!, { recursive: true });
      yield* fs.writeFileString(
        join(path!, "SKILL.md"),
        "---\nname: review\ndescription: Review code\n---\nReview\n",
      );
      yield* fs.utimes(join(path!, "SKILL.md"), new Date(date!), new Date(date!));
    }
    yield* fs.symlink(first, alias);
    const home = yield* libraryHome({
      home: join(root, "home"),
      inventoryHome: root,
      roots: { codex, claude },
    });
    const interaction = yield* makeScriptedInteraction([]);
    const inventory = yield* home.owned(
      inventoryCommand({ libraryHome: home.home, ...home.inventory }).pipe(
        Effect.provide(interaction.layer),
      ),
    );
    expect(
      inventory.machine.instances.map((instance) => instance.skill_md_modified_at).sort(),
    ).toEqual(["2026-01-03T00:00:00.000Z", "2026-09-20T00:00:00.000Z"]);
    expect(yield* skillModificationTime(alias)).toBe("2026-01-03T00:00:00.000Z");
    expect(yield* skillModificationTime(join(root, "missing"))).toBeNull();
    const rendered = renderMachineSkills(inventory.machine);
    expect(rendered).toContain("SKILL.md modified 2026-01-03");
    expect(rendered).toContain("SKILL.md modified 2026-09-20");
    expect(rendered).toContain("linked-review");
    expect(
      renderMachineSkills({
        ...inventory.machine,
        instances: inventory.machine.instances.map((instance) => ({
          ...instance,
          skill_md_modified_at: null,
        })),
      }),
    ).toContain("SKILL.md modified unavailable");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "reads a declared source date without treating retained-file timestamps as source history",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-declared-dates-" });
      const source = join(root, "source");
      const skillPath = join(source, "skills", "review");
      yield* fs.makeDirectory(skillPath, { recursive: true });
      yield* fs.writeFileString(
        join(skillPath, "SKILL.md"),
        "---\nname: review\ndescription: Review code\n---\nReview code.\n",
      );
      yield* fs.writeFileString(
        join(source, "README.md"),
        `---
skit: 1
slug: tools
skills:
  - name: review
    path: skills/review
    source_updated_at: "2026-04-20T00:00:00.000Z"
    default_enabled: true
---
# Tools
`,
      );
      const home = yield* libraryHome({ home: join(root, "home") });
      yield* initializeLibraryMachine(home.home);
      yield* home.owned(
        writingTo(
          home.home,
          retainAuthoredCollectionUnderLockEffect({
            root: source,
            source: { type: "local", path: source },
            input: source,
            retainedAt: "2026-09-29T00:00:00.000Z",
          }),
        ),
      );
      const state = yield* home.durable;
      const metadata = yield* readLibrarySkillMetadata(state, home.originals);
      expect(metadata.get(state.skills[0]!.skill_id)).toMatchObject({
        source_updated_at: "2026-04-20T00:00:00.000Z",
        acquired_at: "2026-09-29T00:00:00.000Z",
        revision: null,
      });
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
