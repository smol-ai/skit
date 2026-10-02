import { it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  codexDuplicateFindings,
  readCodexSkills,
  type CodexDoctorInstance,
} from "../src/workflows/library/doctor-codex.js";
import { NativeLibraryFixture, nativeLibraryLayer } from "./helpers/native-library.js";

const instance = (path: string, extra: Partial<CodexDoctorInstance> = {}): CodexDoctorInstance => ({
  name: "review",
  displayName: "Review",
  path,
  canonicalPath: path,
  scope: "user",
  skitManaged: false,
  documentDigest: "hash-a",
  ...extra,
});

test("separates distinct copies from aliases, across scopes and plugin ownership", () => {
  const source = instance("/work/review/SKILL.md");
  const alias = instance("/codex/review/SKILL.md", { canonicalPath: source.canonicalPath });
  expect(codexDuplicateFindings([source, alias])).toEqual([]);
  const copy = instance("/agents/review/SKILL.md", { skitManaged: true });
  expect(codexDuplicateFindings([source, alias, copy])).toEqual([
    expect.objectContaining({
      kind: "duplicate-name",
      documents: "identical",
      instances: [copy, alias],
    }),
  ]);
  const project = instance("/project/review/SKILL.md", {
    scope: "repo",
    documentDigest: "hash-b",
    pluginId: "example",
  });
  expect(codexDuplicateFindings([copy, project])[0]).toEqual(
    expect.objectContaining({
      kind: "layered-name",
      documents: "different",
      instances: [copy, project],
    }),
  );
  expect(
    codexDuplicateFindings([copy, instance("/missing", { documentDigest: undefined })])[0]
      .documents,
  ).toBe("unknown");
});

test("finds different names sharing a display label without double-reporting ordinary same-name copies", () => {
  const a = instance("/a");
  const b = instance("/b", { name: "review-other" });
  expect(codexDuplicateFindings([a, b])).toEqual([
    expect.objectContaining({
      kind: "display-name-collision",
      name: "Review",
      documents: "identical",
    }),
  ]);
  expect(codexDuplicateFindings([a, instance("/b")]).map((item) => item.kind)).toEqual([
    "duplicate-name",
  ]);
});

it.effect(
  "reads the native response without creating a thread, preserving disabled skills and discovery errors",
  () =>
    Effect.gen(function* () {
      const f = yield* NativeLibraryFixture;
      const fs = yield* FileSystem.FileSystem;
      // Node treats app-server as the script path. The fake checks the actual request protocol.
      yield* fs.writeFileString(
        join(f.root, "app-server"),
        `
      const readline = require('node:readline');
      readline.createInterface({input: process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') console.log(JSON.stringify({id: 1, result: {}}));
        else if (request.method === 'skills/list') {
          if (!request.params.forceReload || require('node:fs').realpathSync(request.params.cwds[0]) !== process.cwd()) process.exit(1);
          console.log(JSON.stringify({method: 'notification'}));
          console.log(JSON.stringify({id: 2, result: {data: [{cwd: request.params.cwds[0], skills: [
            {name: 'review', path: '/a/SKILL.md', scope: 'user', enabled: false, pluginId: null}
          ], errors: [{path: '/bad/SKILL.md', message: 'invalid metadata'}]}]}}));
        } else if (request.method !== 'initialized') process.exit(1);
      });
    `,
      );
      const response = yield* readCodexSkills(process.execPath, f.root);
      expect(response.skills[0].enabled).toBe(false);
      expect(response.errors).toEqual([{ path: "/bad/SKILL.md", message: "invalid metadata" }]);
      // Server would remain alive reading stdin; successful completion requires scope cleanup.
    }).pipe(Effect.provide(nativeLibraryLayer)),
);

it.effect.each(["error", "malformed", "omitted-cwd"])(
  "fails explicitly on native %s responses",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* NativeLibraryFixture;
      const fs = yield* FileSystem.FileSystem;
      const response =
        kind === "error"
          ? { id: 2, error: { message: "unsupported method" } }
          : { id: 2, result: kind === "malformed" ? { data: "invalid" } : { data: [] } };
      yield* fs.writeFileString(
        join(f.root, "app-server"),
        `
      require('node:readline').createInterface({input: process.stdin}).on('line', line => {
        if (JSON.parse(line).method === 'skills/list') console.log(${JSON.stringify(JSON.stringify(response))});
      });
    `,
      );
      const result = yield* Effect.result(readCodexSkills(process.execPath, f.root));
      expect(Result.isFailure(result)).toBe(true);
    }).pipe(Effect.provide(nativeLibraryLayer)),
);

test("preserves every observed alias when native entries share a canonical document", () => {
  const source = instance("/work/review/SKILL.md", {
    aliases: [
      {
        path: "/codex/review",
        via: "symlink",
        linkPath: "/codex/review",
        linkTarget: "/work/review",
      },
    ],
  });
  const alias = instance("/another/review/SKILL.md", {
    canonicalPath: source.canonicalPath,
    aliases: [
      {
        path: "/another/review",
        via: "symlink",
        linkPath: "/another/review",
        linkTarget: "/work/review",
      },
    ],
  });
  const copy = instance("/agents/review/SKILL.md", {
    skitManaged: true,
    aliases: [{ path: "/agents/review", via: "directory" }],
  });
  const finding = codexDuplicateFindings([source, alias, copy])[0];
  expect(finding.instances).toHaveLength(2);
  expect(
    finding.instances.find((item) => item.canonicalPath === source.canonicalPath)?.aliases,
  ).toEqual([...source.aliases!, ...alias.aliases!]);
});
