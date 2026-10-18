import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { join } from "node:path";
import { effectiveGlobalBindings } from "@smolai/skit-core";
import { devices } from "./helpers/library-sync-devices.js";
import { testPlatformLayer } from "./helpers/platform.js";

it.effect("persists an empty device choice before either Library exists", () =>
  Effect.gen(function* () {
    const { a, b, fs } = yield* devices;
    assert.strictEqual(
      (yield* b.sync({ deviceSelection: { skills: [], collections: [] } })).status,
      "clean",
    );
    assert.strictEqual((yield* b.state).device_skill_selection?.mode, "choose");
    const first = yield* a.retain("first");
    yield* a.edit((state) => ({
      ...state,
      global_bindings: [
        {
          scope: { kind: "global" },
          entries: [{ kind: "skill", skill_id: first.skills[0]!.skill_id }],
        },
      ],
    }));
    yield* a.sync();
    yield* b.sync();
    assert.strictEqual((yield* b.state).skills.length, 1);
    assert.isFalse(yield* fs.exists(join(b.root, "first")));
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("syncs new Library content while preserving an edited deselected projection", () =>
  Effect.gen(function* () {
    const { a, b, fs } = yield* devices;
    yield* a.retain("first");
    yield* a.sync();
    yield* b.sync({ deviceSelection: { skills: ["first"], collections: [] } });
    const path = join(b.root, "first", "SKILL.md");
    yield* fs.writeFileString(path, "local edits\n");
    yield* a.retain("second");
    yield* a.sync();
    const result = yield* b.sync({ deviceSelection: { skills: [], collections: [] } });
    assert.strictEqual(result.status, "enablement_incomplete");
    assert.strictEqual((yield* b.state).skills.length, 2);
    assert.strictEqual(yield* fs.readFileString(path), "local edits\n");
    yield* fs.writeFileString(path, "first\n");
    assert.strictEqual((yield* b.sync()).status, "clean");
    assert.isFalse(yield* fs.exists(path));
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("removing a Collection prunes its device choice without leaving choose mode", () =>
  Effect.gen(function* () {
    const { a, b } = yield* devices;
    const first = yield* a.retain("first");
    yield* a.sync();
    yield* b.sync({ deviceSelection: { skills: ["first"], collections: ["fixture/first"] } });
    yield* b.remove(first.collection.collection_id);
    const selection = (yield* b.state).device_skill_selection;
    assert.strictEqual(selection?.mode, "choose");
    if (selection?.mode === "choose") assert.deepStrictEqual(selection.binding.entries, []);
    assert.notStrictEqual((yield* b.sync()).status, "enablement_incomplete");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("retains the full account Library while persisting an individual device choice", () =>
  Effect.gen(function* () {
    const { a, b, c, fs, remote } = yield* devices;
    const first = yield* a.retain("first");
    const second = yield* a.retain("second");
    yield* a.edit((state) => ({
      ...state,
      global_bindings: [
        {
          scope: { kind: "global" },
          entries: [
            { kind: "collection", collection_id: first.collection.collection_id },
            { kind: "collection", collection_id: second.collection.collection_id },
          ],
        },
      ],
    }));
    yield* a.sync();
    const head = yield* remote;
    const pulled = yield* b.sync({ deviceSelection: { skills: ["first"], collections: [] } });
    assert.strictEqual(pulled.status, "pulled");
    assert.strictEqual((yield* b.state).skills.length, 2);
    assert.deepStrictEqual(yield* remote, head);
    assert.isTrue(yield* fs.exists(join(b.root, "first", "SKILL.md")));
    assert.isFalse(yield* fs.exists(join(b.root, "second")));
    assert.strictEqual((yield* b.state).device_skill_selection?.mode, "choose");
    assert.strictEqual((yield* b.sync()).status, "clean");
    assert.isFalse(yield* fs.exists(join(b.root, "second")));
    assert.strictEqual((yield* c.sync()).status, "pulled");
    assert.isTrue(yield* fs.exists(join(c.root, "first", "SKILL.md")));
    assert.isTrue(yield* fs.exists(join(c.root, "second", "SKILL.md")));
    assert.deepStrictEqual(yield* remote, head);
    assert.strictEqual((yield* b.sync({ deviceSelection: "follow-account" })).status, "clean");
    assert.isTrue(yield* fs.exists(join(b.root, "second", "SKILL.md")));
    assert.strictEqual((yield* b.state).device_skill_selection?.mode, "follow-account");
    assert.deepStrictEqual(yield* remote, head);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a blocked selected destination leaves the Library synced and can be retried", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, b, fs, remote } = homes;
    const first = yield* a.retain("first");
    yield* a.edit((state) => ({
      ...state,
      global_bindings: [
        {
          scope: { kind: "global" },
          entries: [{ kind: "skill", skill_id: first.skills[0]!.skill_id }],
        },
      ],
    }));
    yield* a.sync();
    const head = yield* remote;
    yield* fs.makeDirectory(join(b.root, "first"), { recursive: true });
    yield* fs.writeFileString(join(b.root, "first", "SKILL.md"), "existing copy\n");
    const result = yield* b.sync({ deviceSelection: { skills: ["first"], collections: [] } });
    assert.strictEqual(result.status, "enablement_incomplete");
    assert.strictEqual((yield* b.state).skills.length, 1);
    assert.strictEqual(
      yield* fs.readFileString(join(b.root, "first", "SKILL.md")),
      "existing copy\n",
    );
    assert.deepStrictEqual(yield* remote, head);
    const downloads = homes.snapshotReads;
    yield* fs.remove(join(b.root, "first"), { recursive: true });
    assert.strictEqual((yield* b.sync()).status, "clean");
    assert.strictEqual(homes.snapshotReads, downloads);
    assert.strictEqual(yield* fs.readFileString(join(b.root, "first", "SKILL.md")), "first\n");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("an unmanaged symlinked copy blocks enablement after the Library is retained", () =>
  Effect.gen(function* () {
    const { a, b, fs, remote } = yield* devices;
    yield* a.retain("first");
    yield* a.sync();
    const account = join(b.home, "account");
    const root = join(account, ".agents", "skills");
    const source = join(b.home, "existing");
    yield* fs.makeDirectory(join(source, "first"), { recursive: true });
    yield* fs.writeFileString(join(source, "first", "SKILL.md"), "existing copy\n");
    yield* fs.makeDirectory(join(account, ".codex"), { recursive: true });
    yield* fs.symlink(source, join(account, ".codex", "skills"));
    const head = yield* remote;
    const result = yield* b.sync({
      deviceSelection: { skills: ["first"], collections: [] },
      rootFor: (target) => (target === "agents" ? root : undefined),
      inventory: { home: account, configHome: join(account, ".config"), overrides: {} },
    });
    assert.strictEqual(result.status, "enablement_incomplete");
    if (result.status === "enablement_incomplete")
      assert.isTrue(
        result.enablement_issues!.some((issue) =>
          issue.includes(join(account, ".codex", "skills", "first")),
        ),
      );
    assert.strictEqual((yield* b.state).skills.length, 1);
    assert.isFalse(yield* fs.exists(join(root, "first")));
    assert.strictEqual(
      yield* fs.readFileString(join(source, "first", "SKILL.md")),
      "existing copy\n",
    );
    assert.deepStrictEqual(yield* remote, head);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a whole-collection choice follows membership while an individual does not", () =>
  Effect.gen(function* () {
    const { a, b, c, fs } = yield* devices;
    const first = yield* a.retainMany("tools", ["first"], "2026-01-01T00:00:00.000Z");
    yield* a.sync();
    yield* b.sync({ deviceSelection: { skills: ["first"], collections: [] } });
    yield* c.sync({ deviceSelection: { skills: [], collections: ["fixture/tools"] } });
    const individual = yield* b.state;
    const whole = yield* c.state;
    const collection = first.collection.collection_id;
    assert.deepStrictEqual(effectiveGlobalBindings(individual)[0]?.entries[0]?.kind, "skill");
    assert.deepStrictEqual(effectiveGlobalBindings(whole)[0]?.entries, [
      { kind: "collection", collection_id: collection },
    ]);
    yield* a.retainMany("tools", ["first", "new-member"], "2026-02-01T00:00:00.000Z");
    assert.strictEqual((yield* a.sync()).status, "merged");
    assert.strictEqual((yield* b.sync()).status, "merged");
    assert.strictEqual((yield* c.sync()).status, "merged");
    assert.isFalse(yield* fs.exists(join(b.root, "new-member")));
    assert.isTrue(yield* fs.exists(join(c.root, "new-member", "SKILL.md")));
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
