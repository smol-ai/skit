import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Result, Schema } from "effect";
import { skitLayer } from "@smolai/skit-core/platform";
import { deterministicTreeHash } from "@smolai/skit-core/author";
import { openSetupReview, type SetupProgress } from "@smolai/skit-core/library/setup";
import { SetupReviewInputInvalid } from "@smolai/skit-core/library/setup/failures";
import { setupReviewFailure } from "../src/library/setup/review-failures.js";
import { captureDisk } from "./helpers/disk-snapshot.js";
import { libraryHome, importCollectionIn, scratch, writingTo } from "./helpers/library-home.js";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* scratch("skit-setup-review-");
  const agentRoot = join(root, ".codex", "skills");
  const existing = join(root, "source", "alpha");
  const bytes = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\n${name} bytes.\n`;
  for (const [path, name] of [
    [existing, "alpha"],
    [join(agentRoot, "alpha"), "alpha"],
    [join(agentRoot, "beta"), "beta"],
    [join(root, "source", "linked"), "linked"],
  ]) {
    yield* fs.makeDirectory(path, { recursive: true });
    yield* fs.writeFileString(join(path, "SKILL.md"), bytes(name));
  }
  const linked = join(root, "source", "linked");
  const alias = join(agentRoot, "linked");
  yield* fs.symlink(linked, alias);
  const home = yield* libraryHome({
    home: join(root, "library"),
    inventoryHome: root,
    roots: { codex: [agentRoot] },
  });
  yield* Effect.scoped(
    writingTo(
      home.home,
      importCollectionIn(home.home)({
        source: { type: "local", path: existing },
        input: existing,
        importedAt: "2026-10-16T00:00:00.000Z",
        skills: [
          {
            name: "alpha",
            sourcePath: existing,
            relativePath: ".",
            currentHash: yield* deterministicTreeHash(existing),
          },
        ],
        lockFileEntries: [],
      }),
    ),
  );
  const options = {
    libraryHome: home.home,
    inventory: home.inventory,
    persistRoots: false,
    probePath: "",
    skillsStateHome: join(root, "state"),
  };
  const review = yield* home.owned(
    openSetupReview(options, { installOptions: home.installOptions }),
  );
  const scan = review.scan;
  const progress: SetupProgress[] = [];
  const apply = <A, E, R>(stage: SetupProgress, effect: Effect.Effect<A, E, R>) => {
    progress.push(stage);
    return effect;
  };
  return {
    fs,
    root,
    home,
    agentRoot,
    linked,
    alias,
    options,
    observed: scan,
    review,
    apply,
    progress,
  };
});

it.effect("prepares mixed choices without writes and applies their captured meaning", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const before = yield* captureDisk([f.root]);
    const copies = ["alpha", "beta", "remove\0linked"];
    const selected = yield* f.review.selectedCopies(copies);
    assert.deepStrictEqual(
      selected.map((copy) => [copy.name, copy.operation]),
      [
        ["beta", "add"],
        ["alpha", "bind"],
      ],
    );
    const decisions = selected.map((copy) => ({
      ...copy,
      duplicateAction: "retain-only" as const,
    }));
    const plan = yield* f.review.prepare({ sources: [], copies, decisions });
    assert.strictEqual(plan.hasChanges, true);
    assert.deepStrictEqual(
      plan.summary.additions.map((copy) => copy.name),
      ["beta"],
    );
    assert.deepStrictEqual(
      plan.summary.removals.entries.map((entry) => [entry.path, entry.type]),
      [[f.alias, "SymbolicLink"]],
    );
    assert.deepStrictEqual(yield* captureDisk([f.root]), before);
    // Caller-owned inputs and display facts cannot redirect the prepared action.
    copies.length = 0;
    decisions.length = 0;
    plan.summary.removals.entries.length = 0;
    plan.summary.additions.length = 0;
    const applied = yield* f.home.owned(plan.apply(f.apply));
    assert.strictEqual(f.progress[0]?._tag, "RevalidatePlan");
    const applying = f.progress.find((stage) => stage._tag === "ApplyPlan");
    assert.deepStrictEqual(applying, {
      _tag: "ApplyPlan",
      stages: [
        { _tag: "ManageExisting", reconnects: 0 },
        { _tag: "ManageNew", skills: 1 },
        { _tag: "Remove", copies: 1 },
      ],
    });
    assert.strictEqual("applyCommand" in f.observed.onboarding, false);
    assert.strictEqual(f.observed.onboarding.apply, undefined);
    const state = yield* f.home.durable;
    assert.deepStrictEqual(state.skills.map((skill) => skill.name).sort(), ["alpha", "beta"]);
    assert.deepStrictEqual(state.enabled, []);
    assert.strictEqual(yield* f.fs.exists(f.alias), false);
    assert.strictEqual(
      yield* f.fs.readFileString(join(f.linked, "SKILL.md")),
      "---\nname: linked\ndescription: linked\n---\nlinked bytes.\n",
    );
    assert.strictEqual(
      yield* f.fs.exists(join(applied.removalDirectory ?? "", "receipt.json")),
      true,
    );
    assert.strictEqual(yield* f.fs.exists(join(f.agentRoot, "beta", "SKILL.md")), true);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("rejects unavailable choices and missing copy decisions without writes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const before = yield* captureDisk([f.root]);
    for (const [selection, reason] of [
      [
        { sources: ["unobserved"], copies: [], decisions: [] },
        { _tag: "SourceUnavailable", key: "unobserved" },
      ],
      [
        { sources: [], copies: ["unobserved"], decisions: [] },
        { _tag: "ActionUnavailable", value: "unobserved" },
      ],
      [
        { sources: [], copies: ["beta"], decisions: [] },
        { _tag: "DecisionCountMismatch", selected: 1, decisions: 0 },
      ],
    ] as const) {
      const result = yield* Effect.result(f.review.prepare(selection));
      assert.ok(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.ok(Schema.is(SetupReviewInputInvalid)(result.failure));
        if (Schema.is(SetupReviewInputInvalid)(result.failure))
          assert.deepStrictEqual(result.failure.reason, reason);
      }
    }
    assert.deepStrictEqual(yield* captureDisk([f.root]), before);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("refuses changed observations before moving a selected copy", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const plan = yield* f.review.prepare({ sources: [], copies: ["remove\0beta"], decisions: [] });
    const path = join(f.agentRoot, "beta", "SKILL.md");
    yield* f.fs.writeFileString(
      path,
      "---\nname: beta\ndescription: beta\n---\nChanged after review.\n",
    );
    const before = yield* captureDisk([f.root]);
    const result = yield* Effect.result(f.home.owned(plan.apply(f.apply)));
    assert.ok(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "SetupPlanStale");
    assert.deepStrictEqual(yield* captureDisk([f.root]), before);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("comparison retains changed-content facts and leaves the edited copy untouched", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const path = f.review.scan.instances.find((copy) => copy.name === "beta")!.path;
    const expected = yield* deterministicTreeHash(path);
    yield* f.fs.writeFileString(join(path, "SKILL.md"), "Changed after the scan.\n");
    const actual = yield* deterministicTreeHash(path);
    const before = yield* captureDisk([f.root]);
    const result = yield* Effect.result(f.review.compareCopies([path]));
    assert.ok(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.ok(Schema.is(SetupReviewInputInvalid)(result.failure));
      if (Schema.is(SetupReviewInputInvalid)(result.failure)) {
        assert.deepStrictEqual(result.failure.reason, {
          _tag: "ComparisonContentChanged",
          path,
          expected,
          actual,
        });
        const json = Schema.encodeSync(Schema.fromJsonString(SetupReviewInputInvalid))(
          result.failure,
        );
        const restored = Schema.decodeSync(Schema.fromJsonString(SetupReviewInputInvalid))(json);
        assert.deepStrictEqual(restored.reason, result.failure.reason);
        assert.ok(!json.includes('"message"'));
        assert.strictEqual(
          setupReviewFailure(restored).message,
          `The copy at ${path} changed after setup scanned it.`,
        );
      }
    }
    assert.deepStrictEqual(yield* captureDisk([f.root]), before);
  }).pipe(Effect.provide(skitLayer)),
);
