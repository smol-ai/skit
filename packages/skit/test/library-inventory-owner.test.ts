import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { systemError } from "effect/PlatformError";
import { join } from "node:path";
import { refreshInventory } from "../src/library/inventory.js";
import * as Library from "../src/library/library.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";

const folder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "skit-inventory-owner-" }),
  );
  const home = join(root, "library");
  const skills = join(root, "skills");
  const path = join(skills, "review", "SKILL.md");
  const bytes = "---\nname: review\ndescription: Inventory fixture\n---\nExact Skill bytes.\n";
  yield* fs.makeDirectory(join(skills, "review"), { recursive: true });
  yield* fs.writeFileString(path, bytes);
  return { fs, root, home, skills, path, bytes };
});

it.effect(
  "inventory planning is passive and serializable; apply saves observations without changing folders",
  () =>
    Effect.gen(function* () {
      const f = yield* folder;
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const base = yield* library.read;
        const plan = yield* library.plan(
          { _tag: "RefreshInventory", roots: [{ harness: "codex", root: f.skills }] },
          { base },
        );
        assert.isFalse(yield* f.fs.exists(f.home));
        assert.strictEqual(plan.change.unmanaged.length, 1);
        const portable = yield* Schema.decodeUnknownEffect(Library.RefreshInventoryPlan)(
          JSON.parse(JSON.stringify(plan)),
        );
        const applied = yield* library.apply({ _tag: "Apply", plan: portable });
        assert.strictEqual(applied.result.inventory.unmanaged[0].path, join(f.skills, "review"));
        assert.deepStrictEqual(applied.result.keptBackups, []);
        assert.strictEqual(yield* f.fs.readFileString(f.path), f.bytes);
        const saved = yield* library.read;
        assert.strictEqual(saved._tag, "Present");
        if (saved._tag === "Present")
          assert.deepStrictEqual(saved.state.unmanaged, applied.result.inventory.unmanaged);
      }).pipe(Effect.provide(Library.layer({ home: f.home, routing: { _tag: "None" } })));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "inventory apply refuses changed files, changed Library presence and altered plan data",
  () =>
    Effect.gen(function* () {
      const f = yield* folder;
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const base = yield* library.read;
        const plan = yield* library.plan(
          { _tag: "RefreshInventory", roots: [{ harness: "codex", root: f.skills }] },
          { base },
        );
        yield* f.fs.writeFileString(f.path, "operator edit\n");
        const changed = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
        assert.strictEqual(changed._tag, "Failure");
        if (changed._tag === "Failure")
          assert.strictEqual(changed.failure._tag, "Library.StalePlan");
        assert.isFalse(yield* f.fs.exists(join(f.home, "state.json")));
        assert.strictEqual(yield* f.fs.readFileString(f.path), "operator edit\n");
        yield* f.fs.writeFileString(f.path, f.bytes);
        const altered = yield* Effect.result(
          library.apply({
            _tag: "Apply",
            plan: {
              ...plan,
              change: { ...plan.change, next: { ...plan.change.next, unmanaged: [] } },
            },
          }),
        );
        assert.strictEqual(altered._tag, "Failure");
        if (altered._tag === "Failure")
          assert.strictEqual(altered.failure._tag, "Library.StalePlan");
        assert.isFalse(yield* f.fs.exists(join(f.home, "state.json")));
        yield* library.apply({
          _tag: "Apply",
          plan: yield* library.plan({ _tag: "RefreshInventory", roots: [] }, { base }),
        });
        const bytes = yield* f.fs.readFileString(join(f.home, "state.json"));
        const stale = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
        assert.strictEqual(stale._tag, "Failure");
        if (stale._tag === "Failure") assert.strictEqual(stale.failure._tag, "Library.StalePlan");
        assert.strictEqual(yield* f.fs.readFileString(join(f.home, "state.json")), bytes);
        const future = { ...JSON.parse(bytes), future: { keep: "future data" } };
        yield* f.fs.writeFileString(join(f.home, "state.json"), JSON.stringify(future));
        const futurePlan = yield* library.plan(
          { _tag: "RefreshInventory", roots: [{ harness: "codex", root: f.skills }] },
          { base: yield* library.read },
        );
        const decoded = yield* Schema.decodeUnknownEffect(Library.RefreshInventoryPlan)(
          JSON.parse(JSON.stringify(futurePlan)),
        );
        yield* library.apply({ _tag: "Apply", plan: decoded });
        assert.deepStrictEqual(
          JSON.parse(yield* f.fs.readFileString(join(f.home, "state.json"))).future,
          { keep: "future data" },
        );
      }).pipe(Effect.provide(Library.layer({ home: f.home, routing: { _tag: "None" } })));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "a failed backup keep retains saved observations and all bytes; retry completes without duplicate history",
  () =>
    Effect.gen(function* () {
      const f = yield* folder;
      const source = join(f.root, "source");
      yield* f.fs.makeDirectory(source);
      yield* f.fs.writeFileString(join(source, "SKILL.md"), f.bytes);
      // The installed copy is created only through the owner; it must not collide with the raw fixture.
      yield* f.fs.remove(join(f.skills, "review"), { recursive: true });
      const config = {
        home: f.home,
        routing: {
          _tag: "Configured" as const,
          home: f.root,
          configHome: join(f.root, "config"),
          overrides: { codex: [f.skills] },
        },
      };
      const backup = yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const request = yield* localImportRequest(source, "2026-11-04T00:00:00.000Z");
        if (Option.isNone(request)) return yield* Effect.die("Expected a Skill source");
        const imported = yield* library.import.collection(request.value);
        yield* library.apply({
          _tag: "Apply",
          plan: yield* library.plan(
            {
              _tag: "Enabled",
              changes: [
                {
                  _tag: "Enable",
                  subject: { _tag: "Skill", id: imported.skills[0].skill_id },
                  where: [{ kind: "global" }],
                },
              ],
            },
            { base: yield* library.read },
          ),
        });
        const snapshot = yield* library.read;
        if (snapshot._tag === "Absent") return yield* Effect.die("Expected installed state");
        const installed = snapshot.state.installed_skills[0];
        const pending = join(
          f.root,
          ".skit-backups",
          `pending-${installed.installed_skill_id}-fixture`,
        );
        yield* f.fs.makeDirectory(join(f.root, ".skit-backups"), { recursive: true });
        yield* f.fs.copy(installed.path, pending);
        yield* f.fs.writeFileString(join(pending, "operator-note"), "irreplaceable backup bytes\n");
        yield* f.fs.writeFileString(f.path, "changed installed bytes\n");
        yield* library.apply({
          _tag: "Apply",
          plan: yield* library.plan(
            { _tag: "RefreshInventory", roots: [] },
            { base: yield* library.read },
          ),
        });
        yield* f.fs.writeFileString(f.path, f.bytes);
        return {
          pending,
          kept: join(f.root, ".skit-backups", `kept-${installed.installed_skill_id}-fixture`),
        };
      }).pipe(Effect.provide(Library.layer(config)));
      let refuse = true;
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const plan = yield* library.plan(
          { _tag: "RefreshInventory", roots: [] },
          { base: yield* library.read },
        );
        assert.strictEqual(plan.backups.length, 1);
        assert.isTrue(yield* f.fs.exists(backup.pending));
        const failed = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
        assert.strictEqual(failed._tag, "Failure");
        if (failed._tag === "Failure") assert.strictEqual(failed.failure._tag, "PlatformError");
        const saved = yield* library.read;
        assert.strictEqual(saved._tag, "Present");
        if (saved._tag === "Present")
          assert.strictEqual(saved.state.installed_skills[0].status, "installed");
        assert.isTrue(yield* f.fs.exists(backup.pending));
        assert.isFalse(yield* f.fs.exists(backup.kept));
        const history = (yield* library.history).events;
        refuse = false;
        const done = yield* library.apply({
          _tag: "Apply",
          plan: yield* library.plan({ _tag: "RefreshInventory", roots: [] }, { base: saved }),
        });
        assert.strictEqual(done.result.keptBackups.length, 1);
        assert.deepStrictEqual((yield* library.history).events, history);
        assert.strictEqual(
          yield* f.fs.readFileString(join(backup.kept, "operator-note")),
          "irreplaceable backup bytes\n",
        );
        assert.strictEqual(yield* f.fs.readFileString(f.path), f.bytes);
      }).pipe(
        Effect.provide(Library.layer(config)),
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          rename: (from, to) =>
            refuse && from === backup.pending
              ? Effect.fail(
                  systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: from,
                  }),
                )
              : f.fs.rename(from, to),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "refresh reports selected roots without losing saved observations outside them or exposing state",
  () =>
    Effect.gen(function* () {
      const f = yield* folder;
      const other = join(f.root, "other-skills");
      yield* f.fs.makeDirectory(join(other, "older"), { recursive: true });
      yield* f.fs.writeFileString(
        join(other, "older", "SKILL.md"),
        "---\nname: older\ndescription: Other root.\n---\n# Older\n",
      );
      const roots = {
        codex: [f.skills],
        "claude-code": [join(f.root, "claude")],
        opencode: [join(f.root, "opencode")],
        devin: [join(f.root, "devin")],
      };
      for (const paths of Object.values(roots))
        for (const path of paths) yield* f.fs.makeDirectory(path, { recursive: true });
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        yield* library.apply({
          _tag: "Apply",
          plan: yield* library.plan(
            { _tag: "RefreshInventory", roots: [{ harness: "codex", root: other }] },
            { base: yield* library.read },
          ),
        });
        const report = yield* refreshInventory({
          home: f.root,
          configHome: join(f.root, "config"),
          overrides: roots,
        });
        assert.deepStrictEqual(
          report.unmanaged.map((item) => item.path),
          [join(f.skills, "review")],
        );
        for (const field of [
          "schemaVersion",
          "collections",
          "imports",
          "repositories",
          "operations",
          "sync_ancestry",
          "device_skill_selection",
        ])
          assert.isFalse(Object.hasOwn(report, field), `private field leaked: ${field}`);
        const saved = yield* library.read;
        assert.strictEqual(saved._tag, "Present");
        if (saved._tag === "Present")
          assert.deepStrictEqual(
            saved.state.unmanaged.map((item) => item.path).sort(),
            [join(other, "older"), join(f.skills, "review")].sort(),
          );
      }).pipe(Effect.provide(Library.layer({ home: f.home, routing: { _tag: "None" } })));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
