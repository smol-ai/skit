import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import { skitLayer, deterministicTreeHash } from "@smolai/skit-core";
import { openSetupReview } from "../src/workflows/library/setup-review.js";
import { runSetup } from "../src/workflows/library/setup.js";
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
            observedHash: yield* deterministicTreeHash(existing),
          },
        ],
        observations: [],
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
  const observed = yield* home.owned(runSetup(options));
  const review = yield* home.owned(openSetupReview(options, observed, { bindings: home.bindings }));
  const apply = <A, E, R>(_message: string, effect: Effect.Effect<A, E, R>) => effect;
  return { fs, root, home, agentRoot, linked, alias, options, observed, review, apply };
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
    yield* f.home.owned(plan.apply(f.apply));
    const state = yield* f.home.durable;
    assert.deepStrictEqual(state.skills.map((skill) => skill.name).sort(), ["alpha", "beta"]);
    assert.deepStrictEqual(state.enabled, []);
    assert.strictEqual(yield* f.fs.exists(f.alias), false);
    assert.strictEqual(
      yield* f.fs.readFileString(join(f.linked, "SKILL.md")),
      "---\nname: linked\ndescription: linked\n---\nlinked bytes.\n",
    );
    assert.strictEqual(
      yield* f.fs.exists(join(plan.summary.removals.recoveryDirectory, "receipt.json")),
      true,
    );
    assert.strictEqual(yield* f.fs.exists(join(f.agentRoot, "beta", "SKILL.md")), true);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("rejects unavailable choices and missing copy decisions without writes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const before = yield* captureDisk([f.root]);
    for (const selection of [
      { sources: ["unobserved"], copies: [], decisions: [] },
      { sources: [], copies: ["unobserved"], decisions: [] },
      { sources: [], copies: ["beta"], decisions: [] },
    ]) {
      const result = yield* Effect.result(f.review.prepare(selection));
      assert.ok(Result.isFailure(result));
      if (Result.isFailure(result))
        assert.strictEqual(result.failure._tag, "OptionCombinationInvalid");
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
