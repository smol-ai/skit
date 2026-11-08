import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { it } from "@effect/vitest";
import * as Merge from "../src/sync/merge.js";
import { mergeAuthorTree } from "../src/author/merge/files.js";
import { skitLayer } from "../src/platform/layer.js";
import { TreeFile } from "../src/artifact/tree-entry.js";

// Every pure skill rename in github.com/mattpocock/skills (MIT): one folder per rename, holding
// the skill before and after. Regenerate with fixtures/skill-renames/extract.mjs.
const root = join(import.meta.dirname, "fixtures/skill-renames");
const cases = [
  "domain-model-to-grill-with-docs",
  "review-to-code-review",
  "setup-git-guardrails-to-git-guardrails-claude-code",
];
const Rename = Schema.Struct({
  commit: Schema.String,
  from: Schema.String,
  to: Schema.String,
  title: Schema.String,
});

const file = (path: string, bytes: Uint8Array): TreeFile => ({
  path,
  kind: "file",
  bytes,
  mode: 0o644,
});
const tree = Effect.fn("Test.renameTree")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const files: Record<string, TreeFile> = {};
  const walk = Effect.fn("Test.walkRename")(function* (
    current: string,
  ): Effect.fn.Return<void, import("effect/PlatformError").PlatformError> {
    for (const name of yield* fs.readDirectory(current)) {
      const path = join(current, name);
      if ((yield* fs.stat(path)).type === "Directory") yield* walk(path);
      else
        files[relative(directory, path)] = file(
          relative(directory, path),
          yield* fs.readFile(path),
        );
    }
  });
  yield* walk(directory);
  return files;
});
const text = (version: TreeFile | undefined) =>
  version === undefined ? undefined : new TextDecoder().decode(version.bytes);

const edit = "\nAlso check the changelog.\n";
const withEdit = (files: Record<string, TreeFile>, path: string) => ({
  ...files,
  [path]: file(path, new TextEncoder().encode(`${text(files[path])}${edit}`)),
});
type Files = Record<string, TreeFile>;
/** Merge with author sync's tie-breaks: an edit beats a deletion, then ours wins. */
const merge = (base: Files, ours: Files, theirs: Files) => {
  const result = Merge.run(
    mergeAuthorTree,
    {
      base: Option.some(Object.values(base)),
      ours: Option.some(Object.values(ours)),
      theirs: Option.some(Object.values(theirs)),
    },
    Merge.prefer(Merge.present, Merge.always("ours")),
  );
  if (result._tag !== "Clean") throw new Error("expected a clean merge");
  return {
    files: Object.fromEntries(
      Option.getOrThrow(result.value).map((entry) => [
        entry.path,
        Schema.decodeUnknownSync(TreeFile)(entry),
      ]),
    ),
    choices: result.choices,
  };
};
const fixture = Effect.fn("Test.renameFixture")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const entry = yield* Schema.decodeEffect(Schema.fromJsonString(Rename))(
    yield* fs.readFileString(join(root, name, "case.json")),
  );
  return {
    entry,
    base: yield* tree(join(root, name, "before")),
    renamed: yield* tree(join(root, name, "after")),
  };
});
/** The folder holds exactly the renamed skill, with the edit and the new name. */
const expectRenamedWithEdit = (
  entry: typeof Rename.Type,
  plan: ReturnType<typeof merge>,
  renamed: Record<string, TreeFile>,
) => {
  expect(Object.keys(plan.files).sort()).toEqual(Object.keys(renamed).sort());
  const skill = text(plan.files[`${entry.to}/SKILL.md`]);
  expect(skill).toContain(edit.trim());
  expect(skill).toContain(`name: ${entry.to.split("/").at(-1)}`);
  expect(plan.choices).toEqual([]);
};

describe.each(cases)("%s", (name) => {
  it.effect("an unedited rename moves the whole skill", () =>
    Effect.gen(function* () {
      const { base, renamed } = yield* fixture(name);
      const plan = merge(base, renamed, base);
      expect(Object.keys(plan.files).sort()).toEqual(Object.keys(renamed).sort());
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("an edit made at the old path on the other device follows the rename", () =>
    Effect.gen(function* () {
      const { entry, base, renamed } = yield* fixture(name);
      const plan = merge(base, renamed, withEdit(base, `${entry.from}/SKILL.md`));
      expectRenamedWithEdit(entry, plan, renamed);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("a local edit follows a rename that arrives from the other device", () =>
    Effect.gen(function* () {
      const { entry, base, renamed } = yield* fixture(name);
      const plan = merge(base, withEdit(base, `${entry.from}/SKILL.md`), renamed);
      expectRenamedWithEdit(entry, plan, renamed);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("when both devices rename it differently, one skill remains under the local name", () =>
    Effect.gen(function* () {
      const { entry, base, renamed } = yield* fixture(name);
      const elsewhere = Object.fromEntries(
        Object.entries(renamed).map(([path, version]) => [
          path.replace(`${entry.to}/`, `${entry.to}-elsewhere/`),
          { ...version, path: path.replace(`${entry.to}/`, `${entry.to}-elsewhere/`) },
        ]),
      );
      const plan = merge(base, renamed, elsewhere);
      expect(Object.keys(plan.files).sort()).toEqual(Object.keys(renamed).sort());
    }).pipe(Effect.provide(skitLayer)),
  );
});

test("an unrelated skill removed while another is added is not a rename", () => {
  const skill = (name: string, body: string) =>
    file(
      `${name}/SKILL.md`,
      new TextEncoder().encode(`---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`),
    );
  const base = {
    "old/SKILL.md": skill("old", "Write release notes.\nKeep them short."),
  };
  const local = {
    "new/SKILL.md": skill("new", "Review database migrations.\nCheck indexes."),
  };
  const remote = {
    "old/SKILL.md": skill("old", "Write release notes.\nKeep them short.\nAdd links."),
  };
  const plan = merge(base, local, remote);
  // Not paired: the edit beats the deletion of `old`, and `new` is simply added.
  expect(Object.keys(plan.files).sort()).toEqual(["new/SKILL.md", "old/SKILL.md"]);
});
