import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Ref, Schedule, Scope } from "effect";
import { TestClock } from "effect/testing";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { skitLayer } from "../src/platform/layer.js";
import {
  authorLayer,
  updateAuthoredSkills,
  updateAuthorWorkspace,
} from "../src/author/operations.js";
import { initializeAuthorWorkspace } from "../src/author/initialize.js";
import { watchAuthorWorkspace, type AuthorWatchEvent } from "../src/author/watch.js";
import { AuthorWorkspace } from "../src/author/workspace.js";
import { AuthorHistory } from "../src/author/history.js";
import { DatabaseSync } from "node:sqlite";

const content = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name} skills\n---\n${body}\n`;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "skit-authored-install-" }),
  );
  const root = join(directory, "workspace");
  const home = join(directory, "home");
  const agents = join(directory, "agents");
  for (const name of ["review", "explain"]) {
    yield* fs.makeDirectory(join(root, "skills", name), { recursive: true });
    yield* fs.writeFileString(join(root, "skills", name, "SKILL.md"), content(name, "Initial"));
  }
  yield* fs.makeDirectory(join(root, "shared"));
  yield* fs.writeFileString(join(root, "shared/rules.txt"), "shared v1\n");
  yield* fs.writeFileString(join(root, "skills/review/notes.txt"), "last valid supporting input\n");
  yield* fs.writeFileString(
    join(root, "skit.json"),
    JSON.stringify({
      slug: "tools",
      skills: ["review", "explain"].map((name) => ({
        name,
        path: `skills/${name}`,
        shared: [{ from: "shared", to: "context" }],
      })),
    }),
  );
  const layer = Library.layer({
    home,
    roots: {
      home: directory,
      configHome: join(directory, "config"),
      overrides: { codex: [agents] },
    },
  }).pipe(Layer.provideMerge(authorLayer({ home })));
  return { fs, root, home, agents, layer };
});

const enable = Effect.fn("Test.enableAuthoredCollection")(function* (root: string, home: string) {
  const imported = yield* initializeAuthorWorkspace(root, home);
  const library = yield* Library.Service;
  const base = yield* library.read;
  const plan = yield* library.plan(
    {
      _tag: "Enabled",
      changes: [
        {
          _tag: "Enable",
          subject: { _tag: "Collection", id: imported.entry.collection.collection_id },
          members: "whole",
          where: [{ kind: "global" }],
        },
      ],
    },
    { base },
  );
  assert.strictEqual((yield* library.apply({ _tag: "Apply", plan })).result._tag, "Applied");
  return imported.entry.collection.collection_id;
});

it.effect(
  "saved offline edits update enabled copies; unchanged passes add no versions or imports",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        yield* enable(f.root, f.home);
        const library = yield* Library.Service;
        const expected = content("review", "Local edit without Registry access");
        yield* f.fs.writeFileString(join(f.root, "skills/review/SKILL.md"), expected);
        assert.strictEqual((yield* updateAuthoredSkills(f.root)).status, "updated");
        assert.strictEqual(yield* f.fs.readFileString(join(f.agents, "review/SKILL.md")), expected);
        const before = yield* library.read;
        assert.strictEqual((yield* updateAuthoredSkills(f.root)).status, "unchanged");
        const after = yield* library.read;
        assert.strictEqual(after.revision, before.revision);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.live(
  "the foreground watcher installs an atomic save with the Registry offline",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        yield* enable(f.root, f.home);
        yield* f.fs.writeFileString(
          join(f.root, "skit.remote.json"),
          JSON.stringify({
            schema: "skit.remote.v1",
            origin: "https://registry.example",
            namespace: "tim",
            skit: "tools",
          }),
        );
        const ready = yield* Deferred.make<void>();
        const events = yield* Ref.make<readonly AuthorWatchEvent[]>([]);
        yield* watchAuthorWorkspace(
          f.root,
          { home: f.home },
          {
            origin: Effect.succeed("https://registry.example"),
            connect: () => Effect.fail(new Error("Registry is offline")),
          },
          (event) =>
            Ref.update(events, (items) => [...items, event]).pipe(
              Effect.andThen(
                event.event === "installation" ? Deferred.succeed(ready, undefined) : Effect.void,
              ),
              Effect.asVoid,
            ),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(ready);
        const expected = content("review", "Watched atomic save while offline");
        const path = join(f.root, "skills/review/SKILL.md");
        yield* f.fs.writeFileString(`${path}.tmp`, expected);
        yield* f.fs.rename(`${path}.tmp`, path);
        yield* f.fs.readFileString(join(f.agents, "review/SKILL.md")).pipe(
          Effect.filterOrFail(
            (value) => value === expected,
            () => new Error("Installed copy has not advanced"),
          ),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
        );
        yield* Ref.get(events).pipe(
          Effect.filterOrFail(
            (trace) =>
              trace.some(
                (event) =>
                  event.event === "installation" &&
                  event.installed_copies.some(
                    (copy) => copy.skill === "review" && copy.path === join(f.agents, "review"),
                  ),
              ),
            () => new Error("Installed copy event has not arrived"),
          ),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 30 }),
        );
        const beforeIdle = yield* Ref.get(events);
        yield* Effect.sleep("6500 millis");
        const trace = yield* Ref.get(events);
        assert.isTrue(
          trace.some(
            (event) =>
              event.event === "saved_locally" && event.paths.includes("skills/review/SKILL.md"),
          ),
        );
        assert.strictEqual(
          trace.filter((event) => event.event === "installation").length,
          beforeIdle.filter((event) => event.event === "installation").length,
        );
        assert.strictEqual(
          trace.filter((event) => event.event === "retrying" && event.operation === "sync").length,
          1,
        );
        assert.isFalse(
          trace.some(
            (event) =>
              event.event === "saved_locally" &&
              event.paths.some((path) => path.startsWith(".skit/")),
          ),
        );
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
  { timeout: 20_000 },
);

it.effect(
  "an invalid member holds its exact shared inputs while another advances; malformed declarations freeze membership only",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        yield* enable(f.root, f.home);
        const library = yield* Library.Service;
        const original = (yield* library.skills()).find((row) => row.name === "review")!;
        assert.isNull(original.revision);
        assert.isUndefined(original.saved_at);
        yield* TestClock.setTime(new Date("2026-11-08T21:17:28.100Z").getTime());
        for (const name of ["review", "explain"])
          yield* f.fs.writeFileString(
            join(f.root, "skills", name, "SKILL.md"),
            content(name, "Saved baseline"),
          );
        yield* updateAuthoredSkills(f.root);
        const baseline = (yield* library.skills()).find((row) => row.name === "review")!;
        assert.isNotNull(baseline.revision);
        assert.strictEqual(baseline.saved_at, "2026-11-08T21:17:28.100Z");
        yield* TestClock.adjust("1 second");
        const oldReview = yield* f.fs.readFileString(join(f.agents, "review/SKILL.md"));
        yield* f.fs.remove(join(f.root, "skills/review/SKILL.md"));
        yield* f.fs.writeFileString(join(f.root, "shared/rules.txt"), "shared v2\n");
        const expected = content("explain", "Valid member advances");
        yield* f.fs.writeFileString(join(f.root, "skills/explain/SKILL.md"), expected);
        const result = yield* updateAuthoredSkills(f.root);
        assert.isTrue(result.messages.some((message) => message.startsWith("review:")));
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.agents, "review/SKILL.md")),
          oldReview,
        );
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.agents, "review/context/rules.txt")),
          "shared v1\n",
        );
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.agents, "explain/context/rules.txt")),
          "shared v2\n",
        );
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.agents, "explain/SKILL.md")),
          expected,
        );
        const rows = yield* library.skills();
        const held = rows.find((row) => row.name === "review")!;
        const advanced = rows.find((row) => row.name === "explain")!;
        assert.strictEqual(held.revision, baseline.revision);
        assert.strictEqual(held.saved_at, baseline.saved_at);
        assert.strictEqual(held.imported_at, baseline.imported_at);
        assert.notStrictEqual(advanced.revision, baseline.revision);
        assert.strictEqual(advanced.saved_at, "2026-11-08T21:17:29.100Z");
        const before = yield* library.read;
        yield* f.fs.writeFileString(join(f.root, "skills/review/SKILL.md"), "");
        yield* updateAuthoredSkills(f.root);
        assert.strictEqual((yield* library.read).revision, before.revision);
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.agents, "review/SKILL.md")),
          oldReview,
        );
        yield* f.fs.writeFileString(join(f.root, "skit.json"), "{");
        const next = content("explain", "Known member advances with broken root descriptor");
        yield* f.fs.writeFileString(join(f.root, "skills/explain/SKILL.md"), next);
        yield* updateAuthoredSkills(f.root);
        assert.strictEqual(yield* f.fs.readFileString(join(f.agents, "explain/SKILL.md")), next);
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.agents, "review/context/rules.txt")),
          "shared v1\n",
        );
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("an installed-side edit survives while another skill advances", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      yield* enable(f.root, f.home);
      const edited = content("review", "Agent's installed edit");
      yield* f.fs.writeFileString(join(f.agents, "review/SKILL.md"), edited);
      yield* f.fs.writeFileString(
        join(f.root, "skills/review/SKILL.md"),
        content("review", "Authored change"),
      );
      const expected = content("explain", "Independent authored change");
      yield* f.fs.writeFileString(join(f.root, "skills/explain/SKILL.md"), expected);
      yield* updateAuthoredSkills(f.root);
      assert.strictEqual(yield* f.fs.readFileString(join(f.agents, "review/SKILL.md")), edited);
      assert.strictEqual(yield* f.fs.readFileString(join(f.agents, "explain/SKILL.md")), expected);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("observation respects disabled skills and never reimports a removed Collection", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const imported = yield* initializeAuthorWorkspace(f.root, f.home);
      const library = yield* Library.Service;
      yield* f.fs.writeFileString(
        join(f.root, "skills/review/SKILL.md"),
        content("review", "Still disabled"),
      );
      yield* updateAuthoredSkills(f.root);
      assert.isFalse(yield* f.fs.exists(join(f.agents, "review")));
      yield* library.remove({ query: imported.entry.collection.collection_id, dryRun: false });
      const before = yield* library.read;
      assert.strictEqual((yield* updateAuthoredSkills(f.root)).status, "unregistered");
      assert.strictEqual((yield* library.read).revision, before.revision);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "new valid members follow enablement, invalid members stay absent, and repeated scans do not bypass removal grace",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        yield* enable(f.root, f.home);
        yield* updateAuthoredSkills(f.root);
        const configPath = join(f.root, "skit.json");
        const config = JSON.parse(yield* f.fs.readFileString(configPath));
        config.skills.push({ name: "new-skill", path: "skills/new-skill" });
        config.skills.push({ name: "invalid-skill", path: "skills/invalid-skill" });
        yield* f.fs.makeDirectory(join(f.root, "skills/new-skill"));
        yield* f.fs.writeFileString(
          join(f.root, "skills/new-skill/SKILL.md"),
          content("new-skill", "New valid member"),
        );
        yield* f.fs.writeFileString(configPath, JSON.stringify(config));
        yield* updateAuthoredSkills(f.root);
        assert.isTrue(yield* f.fs.exists(join(f.agents, "new-skill/SKILL.md")));
        assert.isFalse(yield* f.fs.exists(join(f.agents, "invalid-skill")));
        config.skills = config.skills.filter(
          (member: { name: string }) => member.name !== "review",
        );
        yield* f.fs.writeFileString(configPath, JSON.stringify(config));
        yield* f.fs.remove(join(f.root, "skills/review"), { recursive: true });
        for (let pass = 0; pass < 3; pass++) {
          yield* updateAuthoredSkills(f.root);
          assert.strictEqual(
            yield* f.fs.readFileString(join(f.agents, "review/SKILL.md")),
            content("review", "Initial"),
          );
        }
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("a supporting-file disappearance is held while unrelated valid input advances", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      yield* enable(f.root, f.home);
      yield* updateAuthoredSkills(f.root);
      yield* f.fs.remove(join(f.root, "skills/review/notes.txt"));
      yield* f.fs.writeFileString(
        join(f.root, "skills/review/SKILL.md"),
        content("review", "Changed while supporting input disappeared"),
      );
      const expected = content("explain", "Unrelated valid edit");
      yield* f.fs.writeFileString(join(f.root, "skills/explain/SKILL.md"), expected);
      for (let pass = 0; pass < 2; pass++) {
        yield* updateAuthoredSkills(f.root);
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.agents, "review/notes.txt")),
          "last valid supporting input\n",
        );
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.agents, "review/SKILL.md")),
          content("review", "Initial"),
        );
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.agents, "explain/SKILL.md")),
          expected,
        );
      }
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("confirmed membership removal uninstalls followed copies after the grace", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      yield* enable(f.root, f.home);
      yield* updateAuthoredSkills(f.root);
      const path = join(f.root, "skit.json");
      const config = JSON.parse(yield* f.fs.readFileString(path));
      config.skills = config.skills.filter((member: { name: string }) => member.name !== "review");
      yield* f.fs.writeFileString(path, JSON.stringify(config));
      yield* f.fs.remove(join(f.root, "skills/review"), { recursive: true });
      yield* updateAuthoredSkills(f.root);
      assert.isTrue(yield* f.fs.exists(join(f.agents, "review/SKILL.md")));
      yield* TestClock.adjust("10 seconds");
      yield* updateAuthoredSkills(f.root);
      assert.isFalse(yield* f.fs.exists(join(f.agents, "review")));
      assert.strictEqual(
        yield* f.fs.readFileString(join(f.agents, "explain/SKILL.md")),
        content("explain", "Initial"),
      );
      const library = yield* Library.Service;
      const before = yield* library.read;
      yield* updateAuthoredSkills(f.root);
      assert.strictEqual((yield* library.read).revision, before.revision);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "manual updates hold the workspace lease but release the Library writer before a failed backup",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        yield* enable(f.root, f.home);
        yield* f.fs.writeFileString(
          join(f.root, "skit.remote.json"),
          JSON.stringify({
            schema: "skit.remote.v1",
            origin: "https://registry.example",
            namespace: "tim",
            skit: "tools",
          }),
        );
        const expected = content("review", "Manual offline edit");
        yield* f.fs.writeFileString(join(f.root, "skills/review/SKILL.md"), expected);
        const workspaces = yield* AuthorWorkspace;
        const root = yield* workspaces.resolveRoot(f.root);
        const outcome = yield* updateAuthorWorkspace(
          root,
          { home: f.home },
          {
            origin: Effect.succeed("https://registry.example"),
            connect: () =>
              Effect.gen(function* () {
                assert.strictEqual(
                  yield* f.fs.readFileString(join(f.agents, "review/SKILL.md")),
                  expected,
                );
                // A second SQLite connection cannot reenter a held writer, even in this process.
                yield* Effect.sync(() => {
                  const database = new DatabaseSync(join(f.home, "lock.sqlite"));
                  try {
                    database.exec("BEGIN IMMEDIATE");
                    database.exec("ROLLBACK");
                  } finally {
                    database.close();
                  }
                });
                const competing = yield* workspaces
                  .acquire(root)
                  .pipe(Effect.scoped, Effect.result);
                assert.strictEqual(competing._tag, "Failure");
                if (competing._tag === "Failure")
                  assert.strictEqual(competing.failure._tag, "AuthorWorkspaceBusy");
                return yield* Effect.fail("Registry offline" as const);
              }),
          },
        );
        assert.strictEqual(outcome.installation._tag, "Success");
        assert.strictEqual(outcome.sync?._tag, "Failure");
        assert.strictEqual(yield* f.fs.readFileString(join(f.agents, "review/SKILL.md")), expected);
        const library = yield* Library.Service;
        const before = yield* library.read;
        yield* updateAuthoredSkills(root);
        assert.strictEqual((yield* library.read).revision, before.revision);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "raw history never approves removal and a fresh runtime restarts pending grace from the saved baseline",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        yield* enable(f.root, f.home);
        yield* updateAuthoredSkills(f.root);
        yield* f.fs.remove(join(f.root, "skills/review/notes.txt"));
        yield* updateAuthoredSkills(f.root);
        yield* TestClock.adjust("20 seconds");
        yield* Effect.gen(function* () {
          const workspaces = yield* AuthorWorkspace;
          const history = yield* AuthorHistory;
          yield* history.refresh(yield* workspaces.resolveRoot(f.root));
          yield* updateAuthoredSkills(f.root);
          assert.isTrue(yield* f.fs.exists(join(f.agents, "review/notes.txt")));
          yield* TestClock.adjust("10 seconds");
          yield* updateAuthoredSkills(f.root);
          assert.isFalse(yield* f.fs.exists(join(f.agents, "review/notes.txt")));
        }).pipe(Effect.provide(Layer.fresh(authorLayer({ home: f.home }))));
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("confirmed removal keeps installed edits while an unrelated valid skill advances", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      yield* enable(f.root, f.home);
      yield* updateAuthoredSkills(f.root);
      const edited = content("review", "Agent edit to keep");
      yield* f.fs.writeFileString(join(f.agents, "review/SKILL.md"), edited);
      const configPath = join(f.root, "skit.json");
      const config = JSON.parse(yield* f.fs.readFileString(configPath));
      config.skills = config.skills.filter((member: { name: string }) => member.name !== "review");
      yield* f.fs.writeFileString(configPath, JSON.stringify(config));
      yield* f.fs.remove(join(f.root, "skills/review"), { recursive: true });
      yield* updateAuthoredSkills(f.root);
      yield* TestClock.adjust("10 seconds");
      const expected = content("explain", "Independent valid update");
      yield* f.fs.writeFileString(join(f.root, "skills/explain/SKILL.md"), expected);
      yield* updateAuthoredSkills(f.root);
      assert.strictEqual(yield* f.fs.readFileString(join(f.agents, "review/SKILL.md")), edited);
      assert.strictEqual(yield* f.fs.readFileString(join(f.agents, "explain/SKILL.md")), expected);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("manual update waits for workspace ownership and installs the latest saved edit", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      yield* enable(f.root, f.home);
      const workspaces = yield* AuthorWorkspace;
      const root = yield* workspaces.resolveRoot(f.root);
      const hold = yield* Scope.make();
      yield* workspaces.acquire(root).pipe(Scope.provide(hold));
      yield* Effect.addFinalizer(() => Scope.close(hold, Exit.void));
      const attempted = yield* Deferred.make<void>();
      const history = yield* AuthorHistory;
      yield* f.fs.writeFileString(
        join(root, "skills/review/SKILL.md"),
        content("review", "First edit"),
      );
      const first = yield* history.refresh(root);
      const pending = yield* updateAuthorWorkspace(
        root,
        { home: f.home },
        {
          origin: Effect.die("Unconnected workspace needs no Registry"),
          connect: () => Effect.die("Unconnected workspace needs no Registry"),
        },
      ).pipe(
        Effect.provideService(AuthorWorkspace, {
          ...workspaces,
          acquire: (root) =>
            workspaces
              .acquire(root)
              .pipe(Effect.tapError(() => Deferred.succeed(attempted, undefined))),
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(attempted);
      const expected = content("review", "Latest edit while manual update waits");
      yield* f.fs.writeFileString(join(root, "skills/review/SKILL.md"), expected);
      const latest = yield* history.refresh(root);
      assert.notStrictEqual(latest.id, first.id);
      yield* Scope.close(hold, Exit.void);
      yield* TestClock.adjust("100 millis");
      const outcome = yield* Fiber.join(pending);
      assert.strictEqual(outcome.installation._tag, "Success");
      assert.strictEqual(yield* f.fs.readFileString(join(f.agents, "review/SKILL.md")), expected);
      const library = yield* Library.Service;
      const before = yield* library.read;
      yield* updateAuthoredSkills(root);
      assert.strictEqual((yield* library.read).revision, before.revision);
      assert.strictEqual((yield* history.refresh(root)).id, latest.id);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "a missing inventory baseline never authorizes disappearance from the installed version",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        yield* enable(f.root, f.home);
        yield* updateAuthoredSkills(f.root);
        const statePath = join(f.home, "author-sync.json");
        const state = JSON.parse(yield* f.fs.readFileString(statePath));
        delete state.inventories;
        yield* f.fs.writeFileString(statePath, JSON.stringify(state));
        yield* f.fs.remove(join(f.root, "skills/review/notes.txt"));
        yield* updateAuthoredSkills(f.root);
        yield* TestClock.adjust("1 hour");
        yield* updateAuthoredSkills(f.root);
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.agents, "review/notes.txt")),
          "last valid supporting input\n",
        );
        yield* f.fs.writeFileString(
          join(f.root, "skills/review/notes.txt"),
          "last valid supporting input\n",
        );
        yield* updateAuthoredSkills(f.root);
        yield* f.fs.remove(join(f.root, "skills/review/notes.txt"));
        yield* updateAuthoredSkills(f.root);
        yield* TestClock.adjust("10 seconds");
        yield* updateAuthoredSkills(f.root);
        assert.isFalse(yield* f.fs.exists(join(f.agents, "review/notes.txt")));
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
