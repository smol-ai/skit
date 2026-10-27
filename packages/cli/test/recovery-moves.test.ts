import { basename, join } from "node:path";
import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { systemError } from "effect/PlatformError";
import { LinkStat, skitLayer, deterministicTreeHash } from "@smolai/skit-core";
import {
  listRecoveryOperations,
  prepareRecoveryRestore,
  inspectRecoveryOperation,
  prepareRecoveryMoves,
} from "../src/library-application/recovery-moves.js";
import { scratch } from "./helpers/library-home.js";

it.effect.each(["prepare", "apply"] as const)(
  "refuses a retargeted approved alias during %s without moving either source",
  (phase) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const links = yield* LinkStat;
      const root = yield* scratch("skit-recovery-moves-");
      const source = join(root, "source");
      const other = join(root, "other");
      const alias = join(root, "alias");
      for (const path of [source, other]) {
        yield* fs.makeDirectory(path);
        yield* fs.writeFileString(join(path, "SKILL.md"), path);
      }
      yield* fs.symlink(source, alias);
      const info = yield* links.identity.lstat(alias);
      const request = {
        name: "review",
        path: alias,
        approvedLink: { dev: info.dev, ino: info.ino, linkTarget: source },
      };
      const prepared = phase === "apply" ? yield* prepareRecoveryMoves(root, [request]) : undefined;
      // Keep the original inode alive so a replacement cannot reuse it.
      yield* fs.rename(alias, `${alias}-approved`);
      yield* fs.symlink(other, alias);
      const failure = yield* Effect.flip(
        prepared ? prepared.apply() : prepareRecoveryMoves(root, [request]),
      );
      expect(failure._tag).toBe("PlanIsStale");
      expect(yield* fs.readLink(alias)).toBe(other);
      expect(yield* fs.readLink(`${alias}-approved`)).toBe(source);
      for (const path of [source, other])
        expect(yield* fs.readFileString(join(path, "SKILL.md"))).toBe(path);
      expect(yield* fs.exists(join(root, "removed"))).toBe(false);
    }).pipe(Effect.provide(skitLayer)),
);

const recoveryFixture = Effect.fn("Test.recoveryFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* scratch("skit-recovery-"));
  const home = join(root, "library");
  const parent = join(root, "skills");
  const source = join(parent, "review");
  const alias = join(parent, "alias");
  const external = join(root, "external");
  yield* fs.makeDirectory(join(source, "empty"), { recursive: true });
  yield* fs.makeDirectory(join(source, ".skit"));
  yield* fs.writeFileString(join(source, "SKILL.md"), "original skill");
  yield* fs.writeFileString(join(source, ".skit", "private"), "control bytes");
  yield* fs.writeFileString(join(source, ".DS_Store"), "incidental bytes");
  yield* fs.writeFileString(external, "outside");
  yield* fs.symlink(external, join(source, ".skit", "external-link"));
  yield* fs.symlink("review", alias);
  const observedHash = yield* deterministicTreeHash(source);
  const plan = yield* prepareRecoveryMoves(home, [
    { name: "review", path: source, observedHash },
    { name: "alias", path: alias },
  ]);
  const operationId = basename(plan.operationDirectory);
  return { fs, root, home, parent, source, alias, external, plan, operationId };
});

it.effect(
  "restores all saved bytes and link text, leaves external edits alone, and restores twice harmlessly",
  () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      expect(yield* f.fs.exists(f.plan.operationDirectory)).toBe(false);
      yield* f.plan.apply();
      const moveRecord = yield* f.fs.readFileString(join(f.plan.recoveryDirectory, "receipt.json"));
      expect(moveRecord).not.toContain('"moved"');
      const preview = yield* prepareRecoveryRestore(f.home, f.operationId);
      expect(preview.summary.entries.map((entry) => entry.status)).toEqual(["saved", "saved"]);
      // Only the link text belongs to the saved inventory; its target is independently writable.
      yield* f.fs.writeFileString(f.external, "new external edit");
      const restored = yield* preview.apply();
      expect(restored.entries.map((entry) => entry.status)).toEqual(["at-original", "at-original"]);
      expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe("original skill");
      expect(yield* f.fs.readFileString(join(f.source, ".skit", "private"))).toBe("control bytes");
      expect(yield* f.fs.readFileString(join(f.source, ".DS_Store"))).toBe("incidental bytes");
      expect(yield* f.fs.readDirectory(join(f.source, "empty"))).toEqual([]);
      expect(yield* f.fs.readLink(f.alias)).toBe("review");
      expect(yield* f.fs.readFileString(f.external)).toBe("new external edit");
      expect(yield* f.fs.readFileString(join(f.plan.recoveryDirectory, "receipt.json"))).toBe(
        moveRecord,
      );
      const repeated = yield* prepareRecoveryRestore(f.home, f.operationId);
      expect((yield* repeated.apply()).planId).toBe(restored.planId);
      expect(yield* f.fs.exists(join(f.home, "state.json"))).toBe(false);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect.each(["move", "restore"] as const)(
  "an interrupted %s leaves a recoverable prefix with immutable evidence",
  (phase) =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      if (phase === "restore") yield* f.plan.apply();
      const restore =
        phase === "restore" ? yield* prepareRecoveryRestore(f.home, f.operationId) : undefined;
      let moves = 0;
      const interrupted = yield* Effect.exit(
        (restore ? restore.apply() : f.plan.apply()).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            rename: (from, to) => {
              if (++moves === 2) return Effect.interrupt;
              return f.fs.rename(from, to);
            },
          }),
        ),
      );
      expect(interrupted._tag).toBe("Failure");
      const inspection = yield* inspectRecoveryOperation(f.home, f.operationId);
      expect(inspection.entries.map((entry) => entry.status)).toEqual(
        phase === "move" ? ["saved", "at-original"] : ["at-original", "saved"],
      );
      const next = yield* prepareRecoveryRestore(f.home, f.operationId);
      expect((yield* next.apply()).entries.every((entry) => entry.status === "at-original")).toBe(
        true,
      );
      expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe("original skill");
      expect(yield* f.fs.readLink(f.alias)).toBe("review");
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "interruption after the move record is written moves nothing and permits inspection",
  () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      const exit = yield* Effect.exit(
        f.plan.apply().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            link: (from, to) =>
              f.fs
                .link(from, to)
                .pipe(Effect.andThen(to.endsWith("receipt.json") ? Effect.interrupt : Effect.void)),
          }),
        ),
      );
      expect(exit._tag).toBe("Failure");
      expect(
        (yield* inspectRecoveryOperation(f.home, f.operationId)).entries.map(
          (entry) => entry.status,
        ),
      ).toEqual(["at-original", "at-original"]);
      expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe("original skill");
    }).pipe(Effect.provide(skitLayer)),
);

it.effect.each(["directory", "dangling-link"] as const)(
  "occupied %s destination preserves both and permits partial restoration",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      yield* f.plan.apply();
      if (kind === "directory") yield* f.fs.makeDirectory(f.source);
      else yield* f.fs.symlink("missing-target", f.source);
      const preview = yield* prepareRecoveryRestore(f.home, f.operationId);
      expect(preview.summary.entries.map((entry) => entry.status)).toEqual(["conflict", "saved"]);
      const restored = yield* preview.apply();
      expect(restored.entries.map((entry) => entry.status)).toEqual(["conflict", "at-original"]);
      expect(
        kind === "directory" ? yield* f.fs.readDirectory(f.source) : yield* f.fs.readLink(f.source),
      ).toEqual(kind === "directory" ? [] : "missing-target");
      expect(yield* f.fs.readFileString(join(restored.entries[0].recoveryPath, "SKILL.md"))).toBe(
        "original skill",
      );
    }).pipe(Effect.provide(skitLayer)),
);

it.effect.each(["content", "control", "identity", "destination", "parent"] as const)(
  "stale restore refuses changed %s without renewing consent",
  (change) =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      yield* f.plan.apply();
      const preview = yield* prepareRecoveryRestore(f.home, f.operationId);
      const saved = preview.summary.entries[0].recoveryPath;
      if (change === "content") yield* f.fs.writeFileString(join(saved, "SKILL.md"), "new bytes");
      if (change === "control")
        yield* f.fs.writeFileString(join(saved, ".skit", "private"), "new control bytes");
      if (change === "identity") {
        yield* f.fs.rename(saved, `${saved}-original`);
        yield* f.fs.copy(`${saved}-original`, saved);
      }
      if (change === "destination") yield* f.fs.makeDirectory(f.source);
      if (change === "parent") {
        yield* f.fs.rename(f.parent, `${f.parent}-original`);
        yield* f.fs.makeDirectory(f.parent);
      }
      expect((yield* Effect.flip(preview.apply()))._tag).toBe("PlanIsStale");
      const inspection = yield* inspectRecoveryOperation(f.home, f.operationId);
      expect(inspection.entries[0].status).toBe("conflict");
      expect(yield* f.fs.readFileString(join(saved, "SKILL.md"))).toBe(
        change === "content" ? "new bytes" : "original skill",
      );
      expect(yield* f.fs.readLink(preview.summary.entries[1].recoveryPath)).toBe("review");
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("a later entry edited during restoration is never silently approved", () =>
  Effect.gen(function* () {
    const f = yield* recoveryFixture();
    yield* f.plan.apply();
    const preview = yield* prepareRecoveryRestore(f.home, f.operationId);
    const savedAlias = preview.summary.entries[1].recoveryPath;
    let moved = false;
    const failure = yield* Effect.flip(
      preview.apply().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              yield* f.fs.rename(from, to);
              if (!moved) {
                moved = true;
                yield* f.fs.rename(savedAlias, `${savedAlias}-original`);
                yield* f.fs.symlink("other", savedAlias);
              }
            }),
        }),
      ),
    );
    expect(failure._tag).toBe("PlanIsStale");
    expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe("original skill");
    expect(yield* f.fs.readLink(savedAlias)).toBe("other");
    expect(yield* f.fs.readLink(`${savedAlias}-original`)).toBe("review");
    expect(yield* f.fs.exists(f.alias)).toBe(false);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("EXDEV refuses without copy/delete fallback and leaves saved source intact", () =>
  Effect.gen(function* () {
    const f = yield* recoveryFixture();
    yield* f.plan.apply();
    const preview = yield* prepareRecoveryRestore(f.home, f.operationId);
    const failure = yield* Effect.flip(
      preview.apply().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          rename: (from) =>
            Effect.fail(
              systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "rename",
                pathOrDescriptor: from,
                cause: { code: "EXDEV" },
              }),
            ),
        }),
      ),
    );
    expect(failure._tag).toBe("PlatformError");
    expect(yield* f.fs.exists(f.source)).toBe(false);
    expect(
      yield* f.fs.readFileString(join(preview.summary.entries[0].recoveryPath, "SKILL.md")),
    ).toBe("original skill");
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "legacy moved flags are ignored and move records remain unchanged after restoration",
  () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      const links = yield* LinkStat;
      const directory = join(f.home, "removed", "legacy-operation");
      yield* f.fs.makeDirectory(directory, { recursive: true });
      const info = yield* links.identity.lstat(f.source);
      const recoveryPath = join(directory, "1-review");
      const moveRecord = JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            name: "review",
            path: f.source,
            recoveryPath,
            type: "Directory",
            dev: info.dev,
            ino: info.ino,
            observedHash: yield* deterministicTreeHash(f.source),
            moved: false,
          },
        ],
      });
      yield* f.fs.writeFileString(join(directory, "receipt.json"), moveRecord);
      yield* f.fs.rename(f.source, recoveryPath);
      const preview = yield* prepareRecoveryRestore(f.home, "legacy-operation");
      expect(preview.summary.legacy).toBe(true);
      expect(preview.summary.entries[0].status).toBe("saved");
      expect((yield* preview.apply()).entries[0].status).toBe("at-original");
      expect(yield* f.fs.readFileString(join(directory, "receipt.json"))).toBe(moveRecord);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect.each(["move-record", "archive-directory", "missing"] as const)(
  "detects %s tampering without restoring anything unsafe",
  (change) =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      yield* f.plan.apply();
      const initial = yield* inspectRecoveryOperation(f.home, f.operationId);
      if (change === "move-record") {
        const moveRecordPath = join(f.plan.recoveryDirectory, "receipt.json");
        const raw = yield* f.fs.readFileString(moveRecordPath);
        yield* f.fs.writeFileString(moveRecordPath, raw.replace("1-review", "../escaped"));
      } else if (change === "archive-directory") {
        yield* f.fs.rename(f.plan.recoveryDirectory, `${f.plan.recoveryDirectory}-original`);
        yield* f.fs.symlink(`${f.plan.recoveryDirectory}-original`, f.plan.recoveryDirectory);
      } else yield* f.fs.remove(initial.entries[0].recoveryPath, { recursive: true });
      if (change === "missing")
        expect((yield* inspectRecoveryOperation(f.home, f.operationId)).entries[0].status).toBe(
          "missing",
        );
      else
        expect((yield* Effect.flip(prepareRecoveryRestore(f.home, f.operationId)))._tag).toBe(
          "RecoveryInvalid",
        );
      expect(yield* f.fs.exists(f.source)).toBe(false);
      expect(yield* f.fs.readFileString(f.external)).toBe("outside");
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "multiple batches share one operation, deduplicate physical aliases, and never rewrite a move record",
  () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture();
      const operation = f.plan.operationDirectory;
      const otherParent = join(f.root, "parent-alias");
      yield* f.fs.symlink(f.parent, otherParent);
      const first = yield* prepareRecoveryMoves(
        f.home,
        [
          { name: "alias", path: f.alias },
          { name: "alias", path: join(otherParent, "alias") },
        ],
        operation,
      );
      const second = yield* prepareRecoveryMoves(
        f.home,
        [
          {
            name: "review",
            path: f.source,
            observedHash: yield* deterministicTreeHash(f.source),
          },
        ],
        operation,
      );
      let publications = 0;
      const counted = {
        ...f.fs,
        link: (from: string, to: string) => {
          if (to.endsWith("receipt.json")) publications++;
          return f.fs.link(from, to);
        },
      };
      yield* first.apply().pipe(Effect.provideService(FileSystem.FileSystem, counted));
      yield* second.apply().pipe(Effect.provideService(FileSystem.FileSystem, counted));
      expect(publications).toBe(2);
      expect(first.entries).toHaveLength(1);
      expect(first.recoveryDirectory).not.toBe(second.recoveryDirectory);
      expect(yield* listRecoveryOperations(f.home)).toEqual([f.operationId]);
      expect(
        (yield* inspectRecoveryOperation(f.home, f.operationId)).entries.map(
          (entry) => entry.status,
        ),
      ).toEqual(["saved", "saved"]);
      const restore = yield* prepareRecoveryRestore(f.home, f.operationId);
      expect(
        (yield* restore.apply()).entries.every((entry) => entry.status === "at-original"),
      ).toBe(true);
      expect(yield* f.fs.readLink(f.alias)).toBe("review");
      expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe("original skill");
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("a planted recovery-container symlink refuses before creating anything through it", () =>
  Effect.gen(function* () {
    const f = yield* recoveryFixture();
    const outside = join(f.root, "outside-storage");
    yield* f.fs.makeDirectory(outside);
    yield* f.fs.makeDirectory(f.home);
    yield* f.fs.symlink(outside, join(f.home, "removed"));
    expect((yield* Effect.flip(f.plan.apply()))._tag).toBe("RecoveryInvalid");
    expect(yield* f.fs.readDirectory(outside)).toEqual([]);
    expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toBe("original skill");
  }).pipe(Effect.provide(skitLayer)),
);
