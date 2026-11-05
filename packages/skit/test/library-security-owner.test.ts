import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { systemError } from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { join } from "node:path";
import { Hash } from "../src/contracts.js";
import { Library } from "../src/library/library.js";
import { openLibraryView } from "../src/library/internal/session/library-view.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";

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

it.effect("passive portable acceptance plans stamp apply time and preserve unknown state", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      yield* library.import.collection(f.request);
      const path = join(f.home, "state.json");
      const saved = JSON.parse(yield* f.fs.readFileString(path));
      yield* f.fs.writeFileString(
        path,
        JSON.stringify({ ...saved, future: { keep: "future data" } }),
      );
      const before = yield* f.fs.readFileString(path);
      const intent = yield* intentFor(f.home);
      const plan = yield* library.plan(intent, { base: yield* library.read });
      assert.isFalse("acceptedAt" in plan.change.acceptance);
      assert.strictEqual(yield* f.fs.readFileString(path), before);
      const codec = Schema.fromJsonString(Library.AcceptFindingPlan);
      const portable = yield* Schema.decodeUnknownEffect(codec)(
        yield* Schema.encodeEffect(codec)(plan),
      );
      assert.isTrue(Option.isNone(portable.intent.expiresAt));
      yield* TestClock.adjust("2 seconds");
      const result = (yield* library.apply({ _tag: "Apply", plan: portable })).result;
      assert.strictEqual(result.acceptance.acceptedAt, "1970-01-01T00:00:02.000Z");
      assert.strictEqual(result.acceptance.principal, "owner@example.test");
      assert.strictEqual(result.acceptance.rationale, "reviewed subprocess use");
      assert.strictEqual(result.review.acceptances[0].status, "applicable");
      assert.strictEqual(result.review.acceptances[0].fingerprint, intent.fingerprint);
      const after = JSON.parse(yield* f.fs.readFileString(path));
      assert.deepStrictEqual(after.future, { keep: "future data" });
      assert.deepStrictEqual(after.assessmentAcceptances, [result.acceptance]);
    }).pipe(Effect.provide(Library.layer({ home: f.home, routing: { _tag: "None" } })));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

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
        const before = yield* f.fs.readFileString(join(f.home, "state.json"));
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
        const portable = yield* Schema.decodeUnknownEffect(codec)(
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
        assert.strictEqual(yield* f.fs.readFileString(join(f.home, "state.json")), before);
      }).pipe(Effect.provide(Library.layer({ home: f.home, routing: { _tag: "None" } })));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

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
        const before = yield* f.fs.readFileString(join(f.home, "state.json"));
        const missing = yield* Effect.result(
          library.plan({ ...intent, fingerprint: Hash.make(`sha256:${"0".repeat(64)}`) }, { base }),
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
        assert.strictEqual(yield* f.fs.readFileString(join(f.home, "state.json")), before);
        yield* f.fs.writeFileString(original, f.bytes);
        yield* library.apply({
          _tag: "Apply",
          plan: yield* library.plan({ _tag: "RefreshInventory", roots: [] }, { base }),
        });
        const stale = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
        assert.strictEqual(stale._tag, "Failure");
        if (stale._tag === "Failure") assert.strictEqual(stale.failure._tag, "Library.StalePlan");
      }).pipe(Effect.provide(Library.layer({ home: f.home, routing: { _tag: "None" } })));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("state publication failure leaves no acceptance and preserves reviewed content", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      yield* (yield* Library.Service).import.collection(f.request);
    }).pipe(Effect.provide(Library.layer({ home: f.home, routing: { _tag: "None" } })));
    const statePath = join(f.home, "state.json");
    const before = yield* f.fs.readFileString(statePath);
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const plan = yield* library.plan(yield* intentFor(f.home), { base: yield* library.read });
      const failed = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
      assert.strictEqual(failed._tag, "Failure");
      if (failed._tag === "Failure") assert.strictEqual(failed.failure._tag, "PlatformError");
      assert.strictEqual(yield* f.fs.readFileString(statePath), before);
      assert.strictEqual(
        yield* f.fs.readFileString(join(plan.folders[0].path, "SKILL.md")),
        f.bytes,
      );
    }).pipe(
      Effect.provide(Library.layer({ home: f.home, routing: { _tag: "None" } })),
      Effect.provideService(FileSystem.FileSystem, {
        ...f.fs,
        rename: (from, to) =>
          to === statePath
            ? Effect.fail(
                systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: to,
                }),
              )
            : f.fs.rename(from, to),
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
