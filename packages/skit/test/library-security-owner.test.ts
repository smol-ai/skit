import * as InstalledSkills from "../src/library/installed-skills.js";
import { applyAcceptance } from "../src/library/internal/security/accept.js";
import { describe } from "@effect/vitest";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { LibraryWriter, writeLibrary, loadLibrary } from "../src/library/store/library-store.js";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { TestClock } from "effect/testing";
import { join } from "node:path";
import { Hash } from "../src/shared/hash.js";
import * as Library from "../src/library/library.js";
import { openLibraryView } from "../src/library/internal/session/library-view.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";
import { saveLibrary, testRoots } from "./helpers/library-store.js";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "skit-security-" }));
  const home = join(root, "library");
  const source = join(root, "source");
  yield* fs.makeDirectory(source);
  const bytes = '---\nname: review\ndescription: Security fixture\n---\nspawn("sh")\n';
  yield* fs.writeFileString(join(source, "SKILL.md"), bytes);
  const request = yield* localImportRequest(source, "2026-11-04T00:00:00.000Z");
  if (Option.isNone(request)) return yield* Effect.die("Expected Skill source");
  return { fs, home, bytes, request: request.value };
});
// Use the same read model as the CLI, without opening a store or writer.
const intentFor = Effect.fn("Test.acceptanceIntent")(function* (home: string) {
  const review = yield* (yield* openLibraryView(home)).securityReview("review");
  const finding = review.audit.findings[0];
  if (finding.fingerprint === undefined)
    return yield* Effect.die("Expected acceptance-eligible finding");
  const fingerprint = yield* Hash.makeEffect(finding.fingerprint);
  return {
    _tag: "AcceptFinding" as const,
    query: "review",
    fingerprint,
    principal: "  owner@example.test  ",
    rationale: "  reviewed subprocess use  ",
    expiresAt: Option.none<string>(),
  };
});

it.effect("acceptance planning leaves saved state unchanged", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;

      yield* library.import.collection(f.request);

      const saved = yield* loadLibrary(f.home);
      const future = { ...saved, future: { keep: "future data" } };
      yield* saveLibrary(f.home, future);
      const before = yield* loadLibrary(f.home);
      const intent = yield* intentFor(f.home);
      const plan = yield* library.plan(intent, { base: yield* library.read });
      assert.isFalse("acceptedAt" in plan.change.acceptance);
      assert.deepStrictEqual(yield* loadLibrary(f.home), before);
      const codec = Schema.fromJsonString(Library.AcceptFindingPlan);
      const portable = yield* Schema.decodeEffect(codec)(yield* Schema.encodeEffect(codec)(plan));

      assert.isTrue(Option.isNone(portable.intent.expiresAt));
    }).pipe(Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("acceptance leaves unknown saved fields intact", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;

      yield* library.import.collection(f.request);

      const saved = yield* loadLibrary(f.home);
      const future = { ...saved, future: { keep: "future data" } };
      yield* saveLibrary(f.home, future);
      const intent = yield* intentFor(f.home);
      const plan = yield* library.plan(intent, { base: yield* library.read });
      const codec = Schema.fromJsonString(Library.AcceptFindingPlan);
      const portable = yield* Schema.decodeEffect(codec)(yield* Schema.encodeEffect(codec)(plan));

      const result = (yield* library.apply({ _tag: "Apply", plan: portable })).result;

      const after = yield* loadLibrary(f.home);

      assert.deepStrictEqual(
        yield* Schema.decodeUnknownEffect(Schema.Struct({ future: Schema.Unknown }))(after),
        { future: { keep: "future data" } },
      );

      assert.deepStrictEqual(after.assessmentAcceptances, [result.acceptance]);
    }).pipe(Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

describe("skit security accept", () => {
  describe("Acceptance that has expired cannot be saved.", () => {
    it.effect(
      "expiry is validated at preview and rechecked at apply without saving expired acceptance",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* Effect.gen(function* () {
            const library = yield* Library.Service;
            yield* library.import.collection(f.request);
            const intent = yield* intentFor(f.home);
            const base = yield* library.read;
            const before = yield* loadLibrary(f.home);
            for (const [value, reason] of [
              ["later", "invalid-expiry"],
              ["1970-01-01T00:00:00Z", "expiry-in-past"],
            ]) {
              const result = yield* Effect.result(
                library.plan({ ...intent, expiresAt: Option.some(value) }, { base }),
              );
              assert.strictEqual(result._tag, "Failure");
              if (result._tag === "Failure") {
                assert.strictEqual(result.failure._tag, "AcceptanceIncomplete");
                if (result.failure._tag === "AcceptanceIncomplete")
                  assert.strictEqual(result.failure.reason, reason);
              }
            }
            const plan = yield* library.plan(
              { ...intent, expiresAt: Option.some("1970-01-01T01:00:01+01:00") },
              { base },
            );
            const codec = Schema.fromJsonString(Library.AcceptFindingPlan);
            const portable = yield* Schema.decodeEffect(codec)(
              yield* Schema.encodeEffect(codec)(plan),
            );
            assert.deepStrictEqual(portable.intent.expiresAt, plan.intent.expiresAt);
            assert.strictEqual(portable.change.acceptance.expiresAt, "1970-01-01T00:00:01.000Z");
            yield* TestClock.adjust("1 second");
            const expired = yield* Effect.result(library.apply({ _tag: "Apply", plan: portable }));
            assert.strictEqual(expired._tag, "Failure");
            if (expired._tag === "Failure") {
              assert.strictEqual(expired.failure._tag, "AcceptanceIncomplete");
              if (expired.failure._tag === "AcceptanceIncomplete")
                assert.strictEqual(expired.failure.reason, "expiry-in-past");
            }
            assert.deepStrictEqual(yield* loadLibrary(f.home), before);
          }).pipe(Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })));
        }).pipe(Effect.scoped, Effect.provide(skitLayer)),
    );
  });
});

describe("skit security accept", () => {
  describe("Changed review data cannot approve a finding.", () => {
    it.effect(
      "acceptance refuses altered plans, absent findings, changed Library and corrupt retained bytes",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* Effect.gen(function* () {
            const library = yield* Library.Service;
            yield* library.import.collection(f.request);
            const intent = yield* intentFor(f.home);
            const base = yield* library.read;
            const plan = yield* library.plan(intent, { base });
            const before = yield* loadLibrary(f.home);
            const missing = yield* Effect.result(
              library.plan(
                { ...intent, fingerprint: Hash.make(`sha256:${"0".repeat(64)}`) },
                { base },
              ),
            );
            assert.strictEqual(missing._tag, "Failure");
            if (missing._tag === "Failure")
              assert.strictEqual(missing.failure._tag, "SecurityFindingAbsent");
            const altered = yield* Effect.result(
              library.apply({
                _tag: "Apply",
                plan: {
                  ...plan,
                  change: { acceptance: { ...plan.change.acceptance, rationale: "unreviewed" } },
                },
              }),
            );
            assert.strictEqual(altered._tag, "Failure");
            if (altered._tag === "Failure")
              assert.strictEqual(altered.failure._tag, "Library.StalePlan");
            const original = join(plan.folders[0].path, "SKILL.md");
            yield* f.fs.writeFileString(original, "operator changed retained bytes\n");
            const changed = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
            assert.strictEqual(changed._tag, "Failure");
            if (changed._tag === "Failure")
              assert.strictEqual(changed.failure._tag, "Library.StalePlan");
            const corrupt = yield* Effect.result(
              (yield* openLibraryView(f.home)).securityReview("review"),
            );
            assert.strictEqual(corrupt._tag, "Failure");
            if (corrupt._tag === "Failure")
              assert.strictEqual(corrupt.failure._tag, "ContentAddressCollision");
            assert.strictEqual(
              yield* f.fs.readFileString(original),
              "operator changed retained bytes\n",
            );
            assert.deepStrictEqual(yield* loadLibrary(f.home), before);
            yield* f.fs.writeFileString(original, f.bytes);
            yield* library.apply({
              _tag: "Apply",
              plan: yield* library.plan({ _tag: "RefreshInventory", roots: [] }, { base }),
            });
            const stale = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
            assert.strictEqual(stale._tag, "Failure");
            if (stale._tag === "Failure")
              assert.strictEqual(stale.failure._tag, "Library.StalePlan");
          }).pipe(Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })));
        }).pipe(Effect.scoped, Effect.provide(skitLayer)),
    );
  });
});

describe("skit security accept", () => {
  describe("A failed acceptance save leaves the prior acceptance unchanged.", () => {
    it.effect("state publication failure leaves no acceptance and preserves reviewed content", () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          yield* (yield* Library.Service).import.collection(f.request);
        }).pipe(Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })));
        const before = yield* loadLibrary(f.home);
        yield* withLibraryDatabase(
          libraryDatabasePath(f.home),
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TRIGGER refuse_acceptance BEFORE UPDATE ON library_device BEGIN SELECT RAISE(ABORT, 'fixture state failure'); END`;
          }),
        );
        yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          const plan = yield* library.plan(yield* intentFor(f.home), { base: yield* library.read });
          const failed = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
          assert.strictEqual(failed._tag, "Failure");
          if (failed._tag === "Failure") assert.strictEqual(failed.failure._tag, "LibrarySqlError");
          assert.deepStrictEqual(yield* loadLibrary(f.home), before);
          assert.strictEqual(
            yield* f.fs.readFileString(join(plan.folders[0].path, "SKILL.md")),
            f.bytes,
          );
        }).pipe(Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })));
      }).pipe(Effect.scoped, Effect.provide(skitLayer)),
    );
  });
});

describe("skit security accept", () => {
  describe("Acceptance applies to one exact Skill Version.", () => {
    it.effect("an applied acceptance records its reviewed attribution at apply time", () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const library = yield* Library.Service;

          yield* library.import.collection(f.request);

          const intent = yield* intentFor(f.home);

          const plan = yield* library.plan(intent, { base: yield* library.read });

          const codec = Schema.fromJsonString(Library.AcceptFindingPlan);

          const portable = yield* Schema.decodeEffect(codec)(
            yield* Schema.encodeEffect(codec)(plan),
          );

          yield* TestClock.adjust("2 seconds");

          const result = (yield* library.apply({ _tag: "Apply", plan: portable })).result;

          assert.strictEqual(result.acceptance.acceptedAt, "1970-01-01T00:00:02.000Z");

          assert.strictEqual(result.acceptance.principal, "owner@example.test");

          assert.strictEqual(result.acceptance.rationale, "reviewed subprocess use");

          assert.strictEqual(result.review.acceptances[0].status, "applicable");

          assert.strictEqual(result.review.acceptances[0].fingerprint, intent.fingerprint);
        }).pipe(Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })));
      }).pipe(Effect.scoped, Effect.provide(skitLayer)),
    );
  });
});

it.effect("acceptance refuses a reentrant mutation after its final content check", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const owner = yield* Library.Service;
      yield* owner.import.collection(f.request);
      const plan = yield* owner.plan(yield* intentFor(f.home), { base: yield* owner.read });
      const files = yield* InstalledSkills.make(testRoots(f.home));
      const current = yield* loadLibrary(f.home);
      const concurrent = { ...current, concurrent: { retained: true } };
      let mutate = Effect.void;
      let checks = 0;
      const controlled = InstalledSkills.Service.of({
        ...files,
        check: (folders) =>
          Effect.gen(function* () {
            yield* files.check(folders);
            checks++;
            if (checks === 2) yield* mutate;
          }),
      });
      const result = yield* Effect.result(
        writeLibrary(
          f.home,
          Effect.gen(function* () {
            const writer = yield* LibraryWriter;
            mutate = writer.save(concurrent, current).pipe(Effect.asVoid, Effect.orDie);
            return yield* applyAcceptance(f.home, plan).pipe(
              Effect.provideService(InstalledSkills.Service, controlled),
            );
          }),
        ),
      );
      assert.strictEqual(checks, 2);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "LibraryChanged");
      const saved = yield* loadLibrary(f.home);
      assert.deepStrictEqual(saved.assessmentAcceptances ?? [], []);
      assert.deepStrictEqual(
        yield* Schema.decodeUnknownEffect(Schema.Struct({ concurrent: Schema.Unknown }))(saved),
        { concurrent: { retained: true } },
      );
    }).pipe(Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
