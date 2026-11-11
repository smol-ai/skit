import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import {
  prepareInstalledSkillRebuild,
  reproducible,
} from "../src/library/installation/retained-skill.js";
import { recoveryFingerprint } from "../src/library/folder-evidence.js";
import { skitLayer } from "../src/platform/layer.js";
import { copySkitFixtureEffect } from "./helpers/skit-fixture.js";
import { collectionVersionPath, originalTreeHash } from "../src/library/collection-version.js";
import { InstalledSkillInvalid } from "../src/library/installation/install-enabled.js";
import { planInstalledSkillChanges } from "../src/library/setup/installed-skills.js";
import { snapshotOf } from "../src/library/snapshot.js";

it.effect("a failed installation preview keeps its typed source failure", () =>
  Effect.gen(function* () {
    const f = yield* authoredFixture;
    const failure = new InstalledSkillInvalid({
      reason: { _tag: "InputsChanged", skillName: "review" },
    });
    const changes = yield* planInstalledSkillChanges(
      { plan: () => Effect.fail(failure) },
      snapshotOf({ present: true, state: f.state }),
    );
    assert.strictEqual(changes.length, f.state.installed_skills.length);
    assert.isAbove(changes.length, 0);
    for (const change of changes) {
      if (!("reason" in change) || change.reason?._tag !== "PlanningFailed")
        return yield* Effect.die("Missing recorded planning failure");
      assert.isTrue(Schema.is(InstalledSkillInvalid)(change.reason.error));
      if (Schema.is(InstalledSkillInvalid)(change.reason.error))
        assert.deepStrictEqual(change.reason.error.reason, failure.reason);
    }
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

const authoredFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-shared-rebuild-" });
  const home = join(root, "library");
  const source = join(root, "source");
  const agents = join(root, "agents");
  yield* copySkitFixtureEffect("authored", source);
  yield* fs.makeDirectory(join(source, "shared"));
  yield* fs.writeFileString(join(source, "shared/rules.md"), "original shared bytes");
  yield* fs.writeFileString(join(source, "shared/alternative.md"), "alternative shared bytes");
  const descriptor = {
    slug: "tools",
    skills: [
      {
        name: "review",
        path: "skills/review",
        invocation: "explicit",
        capabilities: ["filesystem_read"],
        shared: [{ from: "shared/rules.md", to: "context/rules.md" }],
      },
    ],
  };
  yield* fs.writeFileString(join(source, "skit.json"), JSON.stringify(descriptor));
  const installed = yield* Effect.gen(function* () {
    const owner = yield* Library.Service;
    const imported = yield* owner.import.authored({
      root: source,
      source: { type: "local", path: source },
      input: source,
      importedAt: "2026-11-06T00:00:00.000Z",
    });
    const plan = yield* owner.plan(
      {
        _tag: "Enabled",
        changes: [
          {
            _tag: "Enable",
            subject: { _tag: "Collection", id: imported.collection.collection_id },
            members: "whole",
            where: [{ kind: "global" }],
          },
        ],
      },
      { base: yield* owner.read },
    );
    assert.strictEqual((yield* owner.apply({ _tag: "Apply", plan })).result._tag, "Applied");
    const snapshot = yield* owner.read;
    if (snapshot._tag !== "Present") return yield* Effect.die("Missing authored Library");
    const copy = snapshot.state.installed_skills.find(
      (copy) => copy.path === join(agents, "review"),
    );
    if (copy === undefined) return yield* Effect.die("Missing authored installed copy");
    return {
      state: snapshot.state,
      copy,
      retained: collectionVersionPath(join(home, "originals"), imported.snapshotDigest),
    };
  }).pipe(
    Effect.provide(
      Library.layer({
        home,
        roots: {
          home: root,
          configHome: join(root, "config"),
          overrides: { codex: [agents] },
        },
      }),
    ),
  );
  return { fs, root, home, source, descriptor, ...installed };
});

for (const damage of ["shared-bytes", "shared-mapping"] as const)
  it.effect.each(["review", "build", "backup"] as const)(
    `${damage} corruption is refused during %s even though the primary skill directory is intact`,
    (phase) =>
      Effect.gen(function* () {
        const f = yield* authoredFixture;
        assert.isTrue(
          yield* reproducible(
            f.copy.path,
            f.state,
            join(f.home, "originals"),
            f.copy.installed_skill_id,
          ),
        );
        const primary = join(f.retained, "skills/review");
        const before = yield* originalTreeHash(primary);
        const reviewed =
          phase === "build"
            ? yield* prepareInstalledSkillRebuild(f.state, join(f.home, "originals"), f.copy, {
                source: "declared",
              })
            : undefined;
        const replacement =
          damage === "shared-bytes" ? "changed shared bytes" : "alternative shared bytes";
        if (damage === "shared-bytes")
          yield* f.fs.writeFileString(join(f.retained, "shared/rules.md"), replacement);
        else
          yield* f.fs.writeFileString(
            join(f.retained, "skit.json"),
            JSON.stringify({
              ...f.descriptor,
              skills: f.descriptor.skills.map((skill) => ({
                ...skill,
                shared: [{ from: "shared/alternative.md", to: "context/rules.md" }],
              })),
            }),
          );
        assert.strictEqual(yield* originalTreeHash(primary), before);
        const destination = join(f.root, "rebuilt");
        if (phase === "backup") {
          // Matching corrupted retained bytes are not proof that this changed installed copy is
          // reproducible from the recorded immutable Version. Keep the only recovery copy.
          yield* f.fs.writeFileString(join(f.copy.path, "context/rules.md"), replacement);
          assert.isFalse(
            yield* reproducible(
              f.copy.path,
              f.state,
              join(f.home, "originals"),
              f.copy.installed_skill_id,
            ),
          );
        } else if (phase === "review") {
          assert.strictEqual(
            (yield* Effect.flip(
              prepareInstalledSkillRebuild(f.state, join(f.home, "originals"), f.copy, {
                source: "declared",
              }),
            ))._tag,
            "InstalledSkillFailure",
          );
        } else {
          if (reviewed === undefined) return yield* Effect.die("Missing reviewed rebuild");
          assert.strictEqual(
            (yield* Effect.flip(reviewed.build(destination)))._tag,
            "InstalledSkillFailure",
          );
        }
        assert.isFalse(yield* f.fs.exists(destination));
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.source, "shared/rules.md")),
          "original shared bytes",
        );
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("an unrelated retained file does not change a selected skill's rebuild inputs", () =>
  Effect.gen(function* () {
    const f = yield* authoredFixture;
    yield* f.fs.writeFileString(join(f.retained, "unrelated.txt"), "not a selected input");
    const rebuild = yield* prepareInstalledSkillRebuild(
      f.state,
      join(f.home, "originals"),
      f.copy,
      { source: "declared" },
    );
    const destination = join(f.root, "rebuilt");
    yield* rebuild.build(destination);
    assert.strictEqual(
      yield* f.fs.readFileString(join(destination, "context/rules.md")),
      "original shared bytes",
    );
    assert.isTrue(
      yield* reproducible(
        f.copy.path,
        f.state,
        join(f.home, "originals"),
        f.copy.installed_skill_id,
      ),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "the installed-skill byte owner reconstructs a former independent copy from retained artifacts",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-rebuild-" }),
      );
      const home = join(root, "library");
      const source = join(root, "source");
      const agents = join(root, "agents");
      const claude = join(root, "claude");
      const markdown = "---\nname: review\ndescription: review\n---\n\nOriginal bytes\n";
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(join(source, "SKILL.md"), markdown);
      const request = yield* localImportRequest(source, "2026-11-06T00:00:00.000Z");
      if (Option.isNone(request)) return yield* Effect.die("Missing rebuild source");
      yield* Effect.gen(function* () {
        const owner = yield* Library.Service;
        const imported = yield* owner.import.collection(request.value);
        const plan = yield* owner.plan(
          {
            _tag: "Enabled",
            changes: [
              {
                _tag: "Enable",
                subject: { _tag: "Collection", id: imported.collection.collection_id },
                members: "whole",
                where: [{ kind: "global" }],
              },
            ],
          },
          { base: yield* owner.read },
        );
        const applied = yield* owner.apply({ _tag: "Apply", plan });
        assert.strictEqual(applied.result._tag, "Applied");
        const snapshot = yield* owner.read;
        if (snapshot._tag !== "Present") return yield* Effect.die("Missing installed Library");
        const successor = join(claude, "review");
        const prior = snapshot.state.installed_skills.find((copy) => copy.path === successor);
        if (prior === undefined) return yield* Effect.die("Missing installed successor");
        const rebuilt = yield* prepareInstalledSkillRebuild(
          snapshot.state,
          join(home, "originals"),
          prior,
          { source: "declared" },
        );
        const stage = join(root, "reconstructed");
        assert.isFalse(yield* fs.exists(stage));
        yield* rebuilt.build(stage);
        assert.strictEqual(
          yield* recoveryFingerprint(stage, "exclude"),
          yield* recoveryFingerprint(successor, "exclude"),
        );
        assert.isFalse(yield* fs.exists(join(stage, ".skit-ownership.json")));
        yield* fs.writeFileString(join(stage, "SKILL.md"), "Independent writable copy");
        assert.strictEqual(yield* fs.readFileString(join(successor, "SKILL.md")), markdown);
      }).pipe(
        Effect.provide(
          Library.layer({
            home,
            roots: {
              home: root,
              configHome: join(root, "config"),
              overrides: { codex: [agents], "claude-code": [claude] },
            },
          }),
        ),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
