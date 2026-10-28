import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, FileSystem, Result } from "effect";
import { join } from "node:path";
import {
  deterministicTreeHash,
  HarnessName,
  LibraryStore,
  collectionVersionPath,
  resolveDeclaredInvocation,
  importAuthoredCollection,
  skitLayer,
} from "@smolai/skit-core";
import {
  confirmLibraryChange,
  libraryPolicyAfter,
  openLibrarySession,
  proposeLibraryDisable,
  proposeLibraryEnable,
  proposeLibraryInvocation,
} from "../src/library-application/session.js";
import { invocationBriefing, invocationRowSummary } from "../src/invocation/read-model.js";
import {
  initializeLibraryMachine,
  libraryHome,
  importCollectionIn,
  writingTo,
} from "./helpers/library-home.js";

import { openLibraryView } from "../src/library-application/library-view.js";

const text = (explicit: boolean) => `---
name: review
description: Review code
disable-model-invocation: ${explicit}
metadata:
  opencode/autoinvoke: "${!explicit}"
triggers: [user]
---
Review code.
`;

const fixture = Effect.fn("Test.invocationLibrary")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-session-invocation-" });
  const source = join(root, "review");
  yield* fs.makeDirectory(join(source, "agents"), { recursive: true });
  yield* fs.writeFileString(join(source, "SKILL.md"), text(true));
  yield* fs.writeFileString(
    join(source, "agents", "openai.yaml"),
    "policy:\n  allow_implicit_invocation: true\n",
  );
  const home = yield* libraryHome({ home: join(root, "home") });
  yield* initializeLibraryMachine(home.home);
  const importSource = (at: string) =>
    home.owned(
      writingTo(
        home.home,
        Effect.gen(function* () {
          return yield* importCollectionIn(home.home)({
            source: { type: "local", path: source },
            input: source,
            importedAt: at,
            skills: [
              {
                name: "review",
                sourcePath: source,
                relativePath: ".",
                currentHash: yield* deterministicTreeHash(source),
              },
            ],
            lockFileEntries: [],
          });
        }),
      ),
    );
  return { fs, source, home, importSource };
});

it.effect(
  "a session reads native per-agent policy from retained bytes and previews the same install behavior",
  () =>
    Effect.gen(function* () {
      const { fs, source, home, importSource } = yield* fixture();
      yield* importSource("2026-10-01T00:00:00.000Z");
      // The working source is not the authority for a Library row.
      yield* fs.writeFileString(join(source, "SKILL.md"), text(false));
      const before = yield* home.durable;
      const session = yield* home.owned(openLibrarySession());
      const row = session.skills[0]!;
      expect(row.skillId).toBe(before.skills[0]?.skill_id);
      expect(Result.getOrThrow(row.authorInvocation)["claude-code"].policy).toBe("explicit");
      expect(Result.getOrThrow(row.authorInvocation).codex.policy).toBe("implicit");
      const proposed = yield* home.owned(
        proposeLibraryEnable(session, home.installOptions, row, { scope: { kind: "global" } }),
      );
      expect(proposed.pending?.plan.changes[0]?.subject_id).toBe(row.skillId);
      const enabled = yield* home.owned(confirmLibraryChange(proposed));
      expect(enabled.outcome?.kind).toBe("applied");
      const policy = enabled.skills[0]!.scopes[0]!.policy!;
      expect(policy.agents["claude-code"].effectivePolicy).toBe("explicit");
      expect(policy.agents.codex.effectivePolicy).toBe("implicit");
      expect(invocationRowSummary(policy)).toBe("Varies by agent");
      expect(invocationBriefing(policy)).toContain("Claude Code: Only when asked");
      expect(invocationBriefing(policy)).toContain("Codex: Automatically");

      const installedSkill = (yield* home.durable).installed_skills.find(
        (copy) => copy.destination === "agents",
      )!;
      const files = new Map([
        ["SKILL.md", yield* fs.readFileString(join(installedSkill.path, "SKILL.md"))],
        [
          "agents/openai.yaml",
          yield* fs.readFileString(join(installedSkill.path, "agents/openai.yaml")),
        ],
      ]);
      const actual = Result.getOrThrow(
        resolveDeclaredInvocation({ name: "review", path: "." }, (path) => files.get(path)),
      );
      for (const harness of HarnessName.literals)
        expect(policy.agents[harness].effectivePolicy).toBe(actual[harness].policy);

      const explicit = Result.getOrThrow(libraryPolicyAfter(row, "explicit"));
      expect(
        Object.values(explicit.agents).every((agent) => agent.effectivePolicy === "explicit"),
      ).toBe(true);
      const defaults = Result.getOrThrow(libraryPolicyAfter(row, "host-policy"));
      expect(defaults.agents.codex.effectivePolicy).toBe("host-policy");
      expect(defaults.agents.devin.effectivePolicy).toBe("explicit");
      expect(
        Result.getOrThrow(libraryPolicyAfter(row, "declared")).agents["claude-code"].authorPolicy,
      ).toBe("explicit");
      const disabled = yield* home.owned(
        proposeLibraryDisable(
          enabled,
          home.installOptions,
          enabled.skills[0]!,
          enabled.skills[0]!.scopes,
        ),
      );
      expect(disabled.pending?.plan.changes[0]?.subject_id).toBe(row.skillId);
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "session invocation evidence follows the selected retained version rather than the latest acquisition",
  () =>
    Effect.gen(function* () {
      const { fs, source, home, importSource } = yield* fixture();
      yield* importSource("2026-10-01T00:00:00.000Z");
      yield* fs.writeFileString(join(source, "SKILL.md"), text(false));
      yield* importSource("2026-10-02T00:00:00.000Z");
      const state = yield* home.durable;
      yield* home.owned(
        writingTo(
          home.home,
          LibraryStore.use((store) =>
            store.save(
              {
                ...state,
                skills: state.skills.map((skill) => ({
                  ...skill,
                  local_version_id: skill.versions[0]!.skill_version_id,
                })),
              },
              state,
            ),
          ),
        ),
      );
      const selected = yield* home.durable;
      const session = yield* home.owned(openLibrarySession());
      expect(Result.getOrThrow(session.skills[0]!.authorInvocation)["claude-code"].policy).toBe(
        "explicit",
      );
      expect(yield* home.durable).toEqual(selected);
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "declared invocation is read from the selected descriptor and changed retained bytes are unavailable",
  () =>
    Effect.gen(function* () {
      const { fs, source, home } = yield* fixture();
      yield* fs.writeFileString(
        join(source, "agents/openai.yaml"),
        "policy:\n  allow_implicit_invocation: false\n",
      );
      yield* fs.writeFileString(
        join(source, "README.md"),
        `---
skit: 1
slug: tools
skills:
  - name: review
    path: .
    default_enabled: false
    invocation: explicit
---
Tools
`,
      );
      yield* home.owned(
        writingTo(
          home.home,
          importAuthoredCollection({
            root: source,
            source: { type: "local", path: source },
            input: source,
            importedAt: "2026-10-01T00:00:00.000Z",
          }),
        ),
      );
      const session = yield* home.owned(openLibrarySession());
      expect(
        Object.values(Result.getOrThrow(session.skills[0]!.authorInvocation)).every(
          (agent) => agent.source.kind === "skit-declaration",
        ),
      ).toBe(true);
      expect(
        Object.values(
          Result.getOrThrow(libraryPolicyAfter(session.skills[0]!, "declared")).agents,
        ).every((agent) => agent.effectivePolicy === "explicit"),
      ).toBe(true);
      const state = yield* home.durable;
      const imported = collectionVersionPath(home.originals, state.collection_versions[0]!.digest);
      yield* fs.writeFileString(join(imported, "agents", "openai.yaml"), "policy: [\n");
      const broken = yield* home.owned(openLibrarySession());
      expect(Result.isFailure(broken.skills[0]!.authorInvocation)).toBe(true);
      expect(broken.skills[0]?.invocationWarning).toContain("Retained copy for review changed");
      expect(yield* home.durable).toEqual(state);
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("a declared Skill's shared native metadata participates in its session policy", () =>
  Effect.gen(function* () {
    const { fs, source, home } = yield* fixture();
    yield* fs.rename(join(source, "agents"), join(source, "codex-metadata"));
    yield* fs.writeFileString(
      join(source, "README.md"),
      `---
skit: 1
slug: tools
skills:
  - name: review
    path: skill
    default_enabled: false
    shared:
      - from: codex-metadata
        to: agents
---
Tools
`,
    );
    yield* fs.makeDirectory(join(source, "skill"));
    yield* fs.rename(join(source, "SKILL.md"), join(source, "skill", "SKILL.md"));
    yield* home.owned(
      writingTo(
        home.home,
        importAuthoredCollection({
          root: source,
          source: { type: "local", path: source },
          input: source,
          importedAt: "2026-10-01T00:00:00.000Z",
        }),
      ),
    );
    const session = yield* home.owned(openLibrarySession());
    expect(Result.getOrThrow(session.skills[0]!.authorInvocation).codex.policy).toBe("implicit");
    expect(Result.getOrThrow(session.skills[0]!.authorInvocation)["claude-code"].policy).toBe(
      "explicit",
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

for (const problem of ["missing-skill", "malformed-metadata"] as const)
  it.effect(`an unavailable ${problem} row leaves healthy Skills and disable actions usable`, () =>
    Effect.gen(function* () {
      const { fs, source, home, importSource } = yield* fixture();
      if (problem === "malformed-metadata")
        yield* fs.writeFileString(join(source, "agents", "openai.yaml"), "policy: [\n");
      yield* importSource("2026-10-01T00:00:00.000Z");
      const badState = yield* home.durable;
      if (problem === "missing-skill")
        yield* fs.remove(
          join(
            collectionVersionPath(home.originals, badState.collection_versions[0]!.digest),
            "SKILL.md",
          ),
        );
      const healthy = join(source, "..", "healthy");
      yield* fs.makeDirectory(healthy);
      yield* fs.writeFileString(
        join(healthy, "SKILL.md"),
        "---\nname: healthy\ndescription: Healthy\n---\nHealthy.\n",
      );
      yield* home.owned(
        writingTo(
          home.home,
          importCollectionIn(home.home)({
            source: { type: "local", path: healthy },
            input: healthy,
            importedAt: "2026-10-02T00:00:00.000Z",
            skills: [
              {
                name: "healthy",
                sourcePath: healthy,
                relativePath: ".",
                currentHash: yield* deterministicTreeHash(healthy),
              },
            ],
            lockFileEntries: [],
          }),
        ),
      );
      const state = yield* home.durable;
      yield* home.owned(
        writingTo(
          home.home,
          LibraryStore.use((store) =>
            store.save(
              {
                ...state,
                enabled: [{ skill: badState.skills[0]!.skill_id }],
              },
              state,
            ),
          ),
        ),
      );
      const session = yield* home.owned(openLibrarySession());
      const bad = session.skills.find((row) => row.name === "review")!;
      const good = session.skills.find((row) => row.name === "healthy")!;
      expect(Result.isFailure(bad.authorInvocation)).toBe(true);
      expect(bad.invocationWarning).toContain("Author preference unavailable");
      expect(Result.isSuccess(good.authorInvocation)).toBe(true);
      expect(bad.scopes[0]?.policy).toBeUndefined();
      expect(Result.isFailure(libraryPolicyAfter(bad, "declared"))).toBe(true);
      const policyChange = yield* home.owned(
        proposeLibraryInvocation(session, home.installOptions, bad, bad.scopes[0]!, "explicit"),
      );
      expect(policyChange.outcome?.kind).toBe("failed");
      expect(policyChange.pending).toBeUndefined();
      const disabled = yield* home.owned(
        proposeLibraryDisable(session, home.installOptions, bad, bad.scopes),
      );
      expect(disabled.outcome?.kind).toBe("preview");
      const confirmed = yield* home.owned(confirmLibraryChange(disabled));
      expect(confirmed.outcome?.kind).toBe("applied");
      const remaining = confirmed.skills.find((row) => row.skillId === bad.skillId)!;
      expect(remaining.scopes).toHaveLength(0);
      const enable = yield* home.owned(
        proposeLibraryEnable(confirmed, home.installOptions, remaining, {
          scope: { kind: "global" },
        }),
      );
      expect(enable.outcome?.kind).toBe("preview");
      expect(enable.pending?.policies).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
  );

it.effect(
  "a Library read hashes a shared retained copy once and verifies it afresh on the next pass",
  () =>
    Effect.gen(function* () {
      const { fs, source, home } = yield* fixture();
      yield* fs.remove(join(source, "SKILL.md"));
      yield* fs.remove(join(source, "agents"), { recursive: true });
      for (const name of ["alpha", "beta"]) {
        yield* fs.makeDirectory(join(source, name));
        yield* fs.writeFileString(
          join(source, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${name}\n---\n${name}.\n`,
        );
      }
      yield* fs.writeFileString(join(source, "retained-payload.txt"), "Collection payload.\n");
      yield* fs.writeFileString(
        join(source, "README.md"),
        `---
skit: 1
slug: tools
skills:
  - name: alpha
    path: alpha
    default_enabled: false
  - name: beta
    path: beta
    default_enabled: false
---
Tools
`,
      );
      yield* home.owned(
        writingTo(
          home.home,
          importAuthoredCollection({
            root: source,
            source: { type: "local", path: source },
            input: source,
            importedAt: "2026-10-01T00:00:00.000Z",
          }),
        ),
      );
      const state = yield* home.durable;
      const payload = join(
        collectionVersionPath(home.originals, state.collection_versions[0]!.digest),
        "retained-payload.txt",
      );
      let payloadReads = 0;
      const recordingFs = {
        ...fs,
        readFile: (path: string) =>
          fs.readFile(path).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (path === payload) payloadReads++;
              }),
            ),
          ),
      };
      const view = yield* home.owned(openLibraryView());
      const read = home
        .owned(view.readSkills())
        .pipe(Effect.provideService(FileSystem.FileSystem, recordingFs));
      const first = yield* read;
      expect(first).toHaveLength(2);
      expect(first.every((row) => Result.isSuccess(row.authorInvocation))).toBe(true);
      expect(payloadReads).toBe(1);
      expect((yield* read).every((row) => Result.isSuccess(row.authorInvocation))).toBe(true);
      expect(payloadReads).toBe(2);
      yield* fs.writeFileString(payload, "Changed outside any Skill directory.\n");
      expect((yield* read).every((row) => Result.isFailure(row.authorInvocation))).toBe(true);
      expect(payloadReads).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
