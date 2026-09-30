import { join } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { LinkStat, skitLayer } from "@smolai/skit-core";
import { setupCommand } from "../src/handlers/library/setup.js";
import {
  makeScriptedInteraction,
  type ScriptedAnswer,
} from "../src/presentation/interaction-recorder.js";
import { runSetup, revalidateSetupPlan } from "../src/workflows/library/setup.js";
import {
  applySetupRemovals,
  planSetupRemovals,
  setupRemovablePaths,
} from "../src/workflows/library/setup-removal.js";
import { libraryHome, scratch, writingTo } from "./helpers/library-home.js";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* scratch("skit-setup-removal-");
  const agentRoot = join(root, ".codex", "skills");
  const source = join(root, "sources", "linked");
  const copy = join(agentRoot, "copied");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.makeDirectory(join(copy, "empty"), { recursive: true });
  yield* fs.writeFileString(
    join(source, "SKILL.md"),
    "---\nname: linked\ndescription: Linked fixture\n---\n\nOriginal contents\n",
  );
  yield* fs.writeFileString(
    join(copy, "SKILL.md"),
    "---\nname: copied\ndescription: Copied fixture\n---\n\nCopy contents\n",
  );
  yield* fs.writeFileString(join(copy, ".DS_Store"), "incidental bytes");
  const link = join(agentRoot, "linked");
  yield* fs.symlink(source, link);
  const home = yield* libraryHome({
    home: join(root, "library"),
    inventoryHome: root,
    roots: { codex: agentRoot },
  });
  const options = {
    libraryHome: home.home,
    inventory: home.inventory,
    probePath: "",
    skillsStateHome: join(root, "state"),
  };
  const setup = (answers: readonly ScriptedAnswer[], dryRun = false) =>
    Effect.gen(function* () {
      const interaction = yield* makeScriptedInteraction(answers);
      const result = yield* home.owned(
        writingTo(
          home.home,
          setupCommand({
            options,
            cwd: root,
            interactive: true,
            dryRun,
            localCustody: { acquisition: home.addOptions, bindings: home.bindings },
          }).pipe(Effect.provide(interaction.layer)),
        ),
      );
      return { interaction, result };
    });
  return { root, fs, agentRoot, source, copy, link, home, options, setup };
});

it.effect(
  "setup previews exact installed locations, archives copies, and preserves symlink sources",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const { interaction, result } = yield* f.setup([["remove\0copied", "remove\0linked"], true]);
      const plan = (yield* interaction.notes).find((note) => note.title === "Setup plan")!.body;
      expect(plan).toContain(`copied · ${f.copy}`);
      expect(plan).toContain(`linked · ${f.link} (symlink only; source stays)`);
      expect(plan).not.toContain(`linked · ${f.source}`);
      expect(yield* f.fs.exists(f.copy)).toBe(false);
      expect(yield* f.fs.exists(f.link)).toBe(false);
      expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toContain("Original contents");
      const removed = join(f.home.home, "removed");
      const directories = yield* f.fs.readDirectory(removed);
      const recovery = join(removed, directories[0]);
      const receipt = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            entries: Schema.Array(
              Schema.Struct({
                path: Schema.String,
                recoveryPath: Schema.String,
                moved: Schema.Boolean,
                type: Schema.String,
              }),
            ),
          }),
        ),
      )(yield* f.fs.readFileString(join(recovery, "receipt.json")));
      expect(receipt.entries.every((entry) => entry.moved)).toBe(true);
      const directory = receipt.entries.find((entry) => entry.type === "Directory")!;
      expect(yield* f.fs.readDirectory(directory.recoveryPath)).toContain("empty");
      expect(yield* f.fs.readFileString(join(directory.recoveryPath, ".DS_Store"))).toBe(
        "incidental bytes",
      );
      expect((yield* f.home.durable).collections).toHaveLength(0);
      expect(result.instances.some((instance) => instance.name === "copied")).toBe(false);
      for (const entry of receipt.entries) yield* f.fs.rename(entry.recoveryPath, entry.path);
      expect(yield* f.fs.readLink(f.link)).toBe(f.source);
      expect(yield* f.fs.readFileString(join(f.copy, "SKILL.md"))).toContain("Copy contents");
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("declining removal or using dry run leaves copies and Library unchanged", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (const dryRun of [false, true]) {
      yield* f.setup(dryRun ? [] : [["remove\0copied"], false], dryRun);
      expect(yield* f.fs.exists(f.copy)).toBe(true);
      expect(yield* f.fs.exists(join(f.home.home, "removed"))).toBe(false);
      expect((yield* f.home.durable).collections).toHaveLength(0);
    }
    yield* f.setup([[]]);
    expect(yield* f.fs.exists(f.copy)).toBe(true);
    expect(yield* f.fs.exists(join(f.home.home, "removed"))).toBe(false);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("can add one skill and remove another in the same approved setup plan", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.setup([["remove\0copied", "linked"], true]);
    expect(yield* f.fs.exists(f.copy)).toBe(false);
    expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toContain("Original contents");
    expect((yield* f.home.durable).skills.map((skill) => skill.name)).toEqual(["linked"]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("rejects stale consent and replaced paths before moving any copy", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.home.owned(
      writingTo(
        f.home.home,
        Effect.gen(function* () {
          const options = { ...f.options, persistRoots: false };
          const observed = yield* runSetup(options);
          const candidates = observed.onboarding.candidates.filter(
            (item) => item.name === "copied" || item.name === "linked",
          );
          const paths = yield* setupRemovablePaths(options, observed);
          const plan = yield* planSetupRemovals(options, observed, candidates, paths);
          yield* f.fs.writeFileString(
            join(f.copy, "SKILL.md"),
            "---\nname: copied\ndescription: Changed after preview\n---\n",
          );
          expect(
            (yield* Effect.flip(revalidateSetupPlan(options, observed.onboarding.planId)))._tag,
          ).toBe("SetupPlanStale");
          yield* f.fs.rename(f.copy, `${f.copy}-original`);
          yield* f.fs.makeDirectory(f.copy);
          expect((yield* Effect.flip(applySetupRemovals(plan)))._tag).toBe("PlanIsStale");
          expect(yield* f.fs.readLink(f.link)).toBe(f.source);
          expect(yield* f.fs.exists(join(f.home.home, "removed"))).toBe(false);
        }),
      ),
    );
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("does not offer source trees reached through a linked skills root for removal", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const shared = join(f.root, "shared-skills");
    yield* f.fs.makeDirectory(shared);
    yield* f.fs.rename(f.copy, join(shared, "copied"));
    yield* f.fs.rename(f.agentRoot, `${f.agentRoot}-old`);
    yield* f.fs.symlink(shared, f.agentRoot);
    yield* f.home.owned(
      writingTo(
        f.home.home,
        Effect.gen(function* () {
          const observed = yield* runSetup({ ...f.options, persistRoots: false });
          const paths = yield* setupRemovablePaths({ ...f.options, persistRoots: false }, observed);
          expect([...paths.values()].flat()).toEqual([]);
          expect((yield* (yield* LinkStat).lstat(join(shared, "copied"))).type).toBe("Directory");
        }),
      ),
    );
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("removing one duplicate row preserves the independent copy in another agent", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const claude = join(f.root, ".claude", "skills");
    const otherCopy = join(claude, "copied");
    yield* f.fs.makeDirectory(otherCopy, { recursive: true });
    yield* f.fs.copy(f.copy, otherCopy);
    const home = yield* libraryHome({
      home: f.home.home,
      inventoryHome: f.root,
      roots: { codex: f.agentRoot, claude },
    });
    const path = yield* f.fs.realPath(f.copy);
    const interaction = yield* makeScriptedInteraction([[`remove\0copied\0${path}`], true]);
    yield* home.owned(
      writingTo(
        home.home,
        setupCommand({
          options: { ...f.options, inventory: home.inventory },
          cwd: f.root,
          interactive: true,
          dryRun: false,
          localCustody: { acquisition: home.addOptions, bindings: home.bindings },
        }).pipe(Effect.provide(interaction.layer)),
      ),
    );
    expect(yield* f.fs.exists(f.copy)).toBe(false);
    expect(yield* f.fs.readFileString(join(otherCopy, ".DS_Store"))).toBe("incidental bytes");
    expect(yield* f.fs.readLink(f.link)).toBe(f.source);
    const plan = (yield* interaction.notes).find((note) => note.title === "Setup plan")!.body;
    expect(plan).toContain("Remove installed copies: 1");
    expect(plan).not.toContain(`copied · ${otherCopy}`);
  }).pipe(Effect.provide(skitLayer)),
);
