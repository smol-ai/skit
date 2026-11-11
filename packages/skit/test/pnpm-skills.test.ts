import { PnpmEvidenceUnreadable } from "../src/installed-skills/pnpm-failures.js";
import { dirname, join } from "node:path";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, FileSystem, Logger, References, Schema } from "effect";
import { systemError } from "effect/PlatformError";
import { skitLayer } from "../src/platform/layer.js";
import { skitConfigurationLayer } from "../src/platform/configuration.js";
import {
  makePnpmSkillCheck,
  pnpmSkillOwner,
  leavePnpmSkill,
} from "../src/installed-skills/pnpm-skills.js";
import { auditLocalCapabilitiesV1Alpha4 } from "../src/auditing/local.js";

const fixture = Effect.fn("Test.pnpmFixture")(function* (yaml = false) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "skit-pnpm-core-" }));
  const modules = join(root, "node_modules");
  const pkg = join(modules, ".pnpm", "demo@1.0.0", "node_modules", "@acme", "demo");
  const skill = join(pkg, "skills", "guide");
  const alias = join(root, ".agents", "skills", "pnpm-@acme+demo-guide");
  yield* fs.makeDirectory(skill, { recursive: true });
  yield* fs.makeDirectory(dirname(alias), { recursive: true });
  yield* fs.writeFileString(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@acme/demo", version: "1.0.0" }),
  );
  yield* fs.writeFileString(
    join(skill, "SKILL.md"),
    "---\nname: demo-guide\ndescription: Test pnpm distribution\n---\n\nFixture\n",
  );
  yield* fs.symlink(skill, alias);
  const ledgerPath = join(modules, ".modules.yaml");
  const entry = ".agents/skills/pnpm-@acme+demo-guide";
  yield* fs.writeFileString(
    ledgerPath,
    yaml
      ? `packageManager: pnpm@12.11.0\nlinkedSkills:\n  - ${entry}\n`
      : JSON.stringify({ packageManager: "pnpm@12.11.0", linkedSkills: [entry] }),
  );
  return { fs, root, pkg, skill, alias, ledgerPath };
});

it.effect("shares document reads within a scan and starts fresh for mutation checks", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const calls = new Map<string, number>();
    const fs = FileSystem.FileSystem.of({
      ...f.fs,
      readFileString: (path, ...args) =>
        Effect.suspend(() => {
          calls.set(path, (calls.get(path) ?? 0) + 1);
          return f.fs.readFileString(path, ...args);
        }),
    });
    yield* Effect.gen(function* () {
      const checkPnpm = yield* makePnpmSkillCheck();
      expect((yield* checkPnpm(f.alias))?.kind).toBe("pnpm");
      expect((yield* checkPnpm(f.skill))?.kind).toBe("pnpm");
      expect((yield* checkPnpm(f.alias))?.kind).toBe("pnpm");
      expect(calls.get(f.ledgerPath)).toBe(1);
      expect(calls.get(join(f.pkg, "package.json"))).toBe(1);
      expect([...calls.values()].every((count) => count === 1)).toBe(true);

      const ledger = yield* f.fs.readFileString(f.ledgerPath);
      yield* f.fs.writeFileString(f.ledgerPath, "{}");
      const negativeScan = yield* makePnpmSkillCheck();
      expect(yield* negativeScan(f.alias)).toBeUndefined();
      yield* f.fs.writeFileString(f.ledgerPath, ledger);
      const mutation = yield* Effect.result(leavePnpmSkill(f.alias));
      expect(mutation._tag).toBe("Failure");
      if (mutation._tag === "Failure") expect(mutation.failure._tag).toBe("PnpmSkillManaged");
      const refreshed = yield* makePnpmSkillCheck();
      expect((yield* refreshed(f.alias))?.kind).toBe("pnpm");
    }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("reports unreadable evidence, retries it, and keeps missing-file probes quiet", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    let denied = true;
    const messages: unknown[] = [];
    const failure = systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFileString",
      pathOrDescriptor: f.ledgerPath,
    });
    const fs = FileSystem.FileSystem.of({
      ...f.fs,
      readFileString: (path, ...args) =>
        Effect.suspend(() => {
          if (path === f.ledgerPath && denied) {
            denied = false;
            return Effect.fail(failure);
          }
          return f.fs.readFileString(path, ...args);
        }),
    });
    yield* Effect.gen(function* () {
      const checkPnpm = yield* makePnpmSkillCheck();
      expect(yield* checkPnpm(f.alias)).toBeUndefined();
      expect((yield* checkPnpm(f.alias))?.kind).toBe("pnpm");
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
      Effect.provide(Logger.layer([Logger.make((entry) => messages.push(entry.message))])),
    );
    expect(messages).toEqual([[PnpmEvidenceUnreadable.make({ path: f.ledgerPath, failure })]]);
    const notices = messages.flatMap<unknown>((message) =>
      Array.isArray(message) ? message : [message],
    );
    expect(notices.find(Schema.is(PnpmEvidenceUnreadable))?.failure).toBe(failure);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "validates document shapes without rejecting extra fields or invalid neighboring entries",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.writeFileString(
        f.ledgerPath,
        JSON.stringify({
          packageManager: "pnpm@12.11.0",
          linkedSkills: [null, 7, {}, ".agents/skills/pnpm-@acme+demo-guide"],
          future: true,
        }),
      );
      expect((yield* pnpmSkillOwner(f.alias))?.kind).toBe("pnpm");
      yield* f.fs.writeFileString(
        join(f.pkg, "package.json"),
        JSON.stringify({ name: "@acme/demo", version: 1 }),
      );
      expect(yield* pnpmSkillOwner(f.alias)).toBeUndefined();
      yield* f.fs.writeFileString(
        join(f.pkg, "package.json"),
        JSON.stringify({ name: "@acme/demo", version: "1.0.0", future: true }),
      );
      expect((yield* pnpmSkillOwner(f.alias))?.kind).toBe("pnpm");
      yield* f.fs.writeFileString(
        f.ledgerPath,
        JSON.stringify({ packageManager: "pnpm@12.11.0", linkedSkills: "not-an-array" }),
      );
      expect(yield* pnpmSkillOwner(f.alias)).toBeUndefined();
    }).pipe(Effect.provide(skitLayer)),
);

for (const yaml of [false, true]) {
  it.effect(`attributes live pnpm links using ${yaml ? "YAML" : "JSON"} ledger evidence`, () =>
    Effect.gen(function* () {
      const f = yield* fixture(yaml);
      const expected = {
        kind: "pnpm",
        package: "@acme/demo",
        version: "1.0.0",
        ledgerPath: f.ledgerPath,
      };
      expect(yield* pnpmSkillOwner(f.alias)).toEqual(expected);
      expect(yield* pnpmSkillOwner(f.skill)).toEqual(expected);
      const audited = yield* auditLocalCapabilitiesV1Alpha4({ home: f.root, cwd: f.root }).pipe(
        Effect.provide(skitConfigurationLayer()),
      );
      expect(
        audited.skills.find((entry) => entry.location === join(f.alias, "SKILL.md"))?.provenance,
      ).toEqual({
        confidence: "exact",
        origin: { _tag: "PnpmPackage", package: "@acme/demo", version: "1.0.0" },
        evidence: f.ledgerPath,
      });
      expect((yield* Effect.result(leavePnpmSkill(f.alias)))._tag).toBe("Failure");
    }).pipe(Effect.provide(skitLayer)),
  );
}

it.effect(
  "does not infer pnpm management from unrecorded aliases, prefixes, stale ledgers or replaced directories",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const unrecorded = join(f.root, ".agents", "skills", "user-guide");
      yield* f.fs.symlink(f.skill, unrecorded);
      expect(yield* pnpmSkillOwner(unrecorded)).toBeUndefined();
      yield* f.fs.writeFileString(f.ledgerPath, "{}");
      expect(yield* pnpmSkillOwner(f.alias)).toBeUndefined();
      yield* f.fs.writeFileString(
        f.ledgerPath,
        JSON.stringify({
          packageManager: "pnpm@12.11.0",
          linkedSkills: ["../.agents/skills/pnpm-@acme+demo-guide"],
        }),
      );
      expect(yield* pnpmSkillOwner(f.alias)).toBeUndefined();
      yield* f.fs.writeFileString(
        f.ledgerPath,
        JSON.stringify({
          packageManager: "pnpm@12.11.0",
          linkedSkills: [".agents/skills/pnpm-@acme+demo-guide"],
        }),
      );
      yield* f.fs.remove(f.alias, { recursive: true });
      yield* f.fs.makeDirectory(f.alias);
      expect(yield* pnpmSkillOwner(f.skill)).toBeUndefined();
      yield* f.fs.remove(f.alias, { recursive: true });
      yield* f.fs.symlink(join(f.root, "missing"), f.alias);
      expect(yield* pnpmSkillOwner(f.alias)).toBeUndefined();
      yield* f.fs.writeFileString(f.ledgerPath, "[malformed");
      expect(yield* pnpmSkillOwner(f.skill)).toBeUndefined();
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "recognizes linked workspace packages only when the installed dependency corroborates the target",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const local = join(f.root, "packages", "demo");
      yield* f.fs.makeDirectory(dirname(local), { recursive: true });
      yield* f.fs.rename(f.pkg, local);
      yield* f.fs.remove(f.alias);
      const skill = join(local, "skills", "guide");
      yield* f.fs.symlink(skill, f.alias);
      expect(yield* pnpmSkillOwner(f.alias)).toBeUndefined();
      yield* f.fs.makeDirectory(join(f.root, "node_modules", "@acme"), { recursive: true });
      yield* f.fs.symlink(local, join(f.root, "node_modules", "@acme", "demo"));
      expect((yield* pnpmSkillOwner(f.alias))?.kind).toBe("pnpm");
      expect(yield* pnpmSkillOwner(skill)).toBeUndefined();
    }).pipe(Effect.provide(skitLayer)),
);
