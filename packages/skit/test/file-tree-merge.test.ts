import { Option } from "effect";
import { describe, expect, test } from "vitest";
import { conflictKind, fileTree, historyTree, Merge, type SyncFileVersion } from "../src/index.js";

// An edit beats a deletion, then our version wins.
const oursWins = Merge.prefer(Merge.present, Merge.always("ours"));

function file(content: string | Uint8Array): SyncFileVersion {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return { bytes, mode: 0o644 };
}

type Files = Record<string, SyncFileVersion>;
const merge = (base: Files, ours: Files, theirs: Files, choose?: Merge.Chooser) =>
  Merge.run(
    fileTree,
    { base: Option.some(base), ours: Option.some(ours), theirs: Option.some(theirs) },
    choose,
  );
/** The merged files; throws when the merge left conflicts. */
const merged = (result: Merge.Result<Readonly<Files>>) => {
  if (result._tag !== "Clean") throw new Error("expected a clean merge");
  return Option.getOrThrow(result.value);
};
const conflicts = (result: Merge.Result<Readonly<Files>>) =>
  result._tag === "Conflicts"
    ? result.conflicts.map((found) => ({ path: String(found.at[0]), kind: conflictKind(found) }))
    : [];
const choices = (result: Merge.Result<Readonly<Files>>) =>
  result.choices.map(({ conflict, kept }) => ({
    path: String(conflict.at[0]),
    kind: conflictKind(conflict),
    kept,
  }));
const text = (version: SyncFileVersion | undefined) => new TextDecoder().decode(version!.bytes);

describe("file tree merge", () => {
  test("combines independent changes deterministically", () => {
    const base = { "a.txt": file("base"), "b.txt": file("base") };
    const local = { "a.txt": file("local"), "b.txt": base["b.txt"] };
    const remote = { "a.txt": base["a.txt"], "b.txt": file("remote") };
    const files = merged(merge(base, local, remote));
    expect(text(files["a.txt"])).toBe("local");
    expect(text(files["b.txt"])).toBe("remote");
  });

  test.each([
    {
      name: "independent insertions",
      base: "a\nb\nc\n",
      local: "a\nlocal\nb\nc\n",
      remote: "a\nb\nc\nremote\n",
      expected: "a\nlocal\nb\nc\nremote\n",
    },
    {
      name: "deletion and distant replacement",
      base: "a\nb\nc\nd\ne\n",
      local: "a\nc\nd\ne\n",
      remote: "a\nb\nc\nd\nremote\n",
      expected: "a\nc\nd\nremote\n",
    },
    {
      name: "adjacent replacements",
      base: "a\nb\n",
      local: "local\nb\n",
      remote: "a\nremote\n",
      expected: "local\nremote\n",
    },
    {
      name: "CRLF and no final newline",
      base: "a\r\nb\r\nc",
      local: "a\r\nlocal\r\nb\r\nc",
      remote: "a\r\nb\r\nc\r\nremote",
      expected: "a\r\nlocal\r\nb\r\nc\r\nremote",
    },
    {
      name: "prototype-named lines",
      base: "constructor\n__proto__\ntoString\n",
      local: "constructor\nlocal\n__proto__\ntoString\n",
      remote: "constructor\n__proto__\ntoString\nremote\n",
      expected: "constructor\nlocal\n__proto__\ntoString\nremote\n",
    },
  ])("merges $name in either device order", ({ base, local, remote, expected }) => {
    for (const [left, right] of [
      [local, remote],
      [remote, local],
    ]) {
      const result = merge(
        { "SKILL.md": file(base) },
        { "SKILL.md": file(left) },
        { "SKILL.md": file(right) },
      );
      expect(conflicts(result)).toEqual([]);
      expect(new TextDecoder().decode(merged(result)["SKILL.md"].bytes)).toBe(expected);
    }
  });

  test("identical insertions are retained once", () => {
    const result = merge(
      { "a.txt": file("a\nb\n") },
      { "a.txt": file("a\nshared\nb\n") },
      { "a.txt": file("a\nshared\nb\n") },
    );
    expect(conflicts(result)).toEqual([]);
    expect(new TextDecoder().decode(merged(result)["a.txt"].bytes)).toBe("a\nshared\nb\n");
  });

  test("overlapping insertions remain a conflict without marker text", () => {
    const result = merge(
      { "a.txt": file("a\nb\n") },
      { "a.txt": file("a\nlocal\nb\n") },
      { "a.txt": file("a\nremote\nb\n") },
    );
    expect(conflicts(result)).toEqual([{ path: "a.txt", kind: "both_modified" }]);
  });

  test.each([new Uint8Array([0xff, 10, 97]), new Uint8Array([0, 10, 97])])(
    "does not decode malformed UTF-8 or NUL-bearing text into a merged file",
    (bytes) => {
      const result = merge(
        { "a.txt": file("base\na") },
        { "a.txt": file(bytes) },
        { "a.txt": file("remote\na") },
      );
      expect(conflicts(result)).toEqual([{ path: "a.txt", kind: "binary" }]);
    },
  );

  test("preserves a UTF-8 BOM during a text merge", () => {
    const result = merge(
      { "a.txt": file("\ufeffa\nb\nc\n") },
      { "a.txt": file("\ufeffa\nlocal\nb\nc\n") },
      { "a.txt": file("\ufeffa\nb\nc\nremote\n") },
    );
    expect(conflicts(result)).toEqual([]);
    expect(merged(result)["a.txt"].bytes).toEqual(
      new TextEncoder().encode("\ufeffa\nlocal\nb\nc\nremote\n"),
    );
  });

  test.each([
    {
      path: "settings.yaml",
      base: "first: 1\nmiddle: 2\nlast: 3\n",
      local: "first: 1\nextra: left\nmiddle: 2\nlast: 3\n",
      remote: "first: 1\nmiddle: 2\nlast: 3\nextra: right\n",
    },
    {
      path: "skills/review/SKILL.md",
      base: "---\nname: review\ndescription: Review code.\nlicense: MIT\n---\nBody\n",
      local: "---\nname: review\nextra: left\ndescription: Review code.\nlicense: MIT\n---\nBody\n",
      remote:
        "---\nname: review\ndescription: Review code.\nlicense: MIT\nextra: right\n---\nBody\n",
    },
  ])(
    "rejects a syntactically invalid synthesis of two valid $path inputs",
    ({ path, base, local, remote }) => {
      const result = merge(
        { [path]: file(base) },
        { [path]: file(local) },
        { [path]: file(remote) },
      );
      expect(conflicts(result)).toEqual([{ path, kind: "both_modified" }]);
      // Exactly the same line edits are non-overlapping plain text. Syntax is the reason.
      const plain = merge(
        { "notes.txt": file(base) },
        { "notes.txt": file(local) },
        { "notes.txt": file(remote) },
      );
      expect(conflicts(plain)).toEqual([]);
    },
  );

  test("preserves independently authored invalid YAML instead of adding a validation gate", () => {
    const path = "settings.yaml";
    const base = "first: [\nmiddle: 2\nlast: 3\n";
    const local = "first: [\nextra: left\nmiddle: 2\nlast: 3\n";
    const remote = "first: [\nmiddle: 2\nlast: 3\nextra: right\n";
    const result = merge({ [path]: file(base) }, { [path]: file(local) }, { [path]: file(remote) });
    expect(conflicts(result)).toEqual([]);
    expect(new TextDecoder().decode(merged(result)[path].bytes)).toBe(
      "first: [\nextra: left\nmiddle: 2\nlast: 3\nextra: right\n",
    );
  });

  test("merges valid JSON changes without changing their syntax", () => {
    const base = '{\n  "first": 1,\n  "middle": 2,\n  "last": 3\n}\n';
    const local = base.replace('"first": 1', '"first": 10');
    const remote = base.replace('"last": 3', '"last": 30');
    const result = merge(
      { "settings.json": file(base) },
      { "settings.json": file(local) },
      { "settings.json": file(remote) },
    );
    expect(conflicts(result)).toEqual([]);
    expect(new TextDecoder().decode(merged(result)["settings.json"].bytes)).toBe(
      local.replace('"last": 3', '"last": 30'),
    );
  });

  test("automatic overlap resolution preserves remote edits outside the overlapping hunk", () => {
    const base = "first\nanchor\nmiddle\nanchor2\nlast\n";
    const local = base.replace("first", "local first");
    const remote = base.replace("first", "remote first").replace("last", "remote last");
    const result = merge(
      { "a.txt": file(base) },
      { "a.txt": file(local) },
      { "a.txt": file(remote) },
      oursWins,
    );
    expect(conflicts(result)).toEqual([]);
    expect(choices(result)).toEqual([{ path: "a.txt", kind: "both_modified", kept: "ours" }]);
    expect(new TextDecoder().decode(merged(result)["a.txt"].bytes)).toBe(
      local.replace("last", "remote last"),
    );
  });

  test.each([false, true])(
    "automatic edit/delete resolution keeps edited content (local edit: %s)",
    (localEdit) => {
      const edited = { "a.txt": file("edited") };
      const result = merge(
        { "a.txt": file("base") },
        localEdit ? edited : {},
        localEdit ? {} : edited,
        oursWins,
      );
      expect(conflicts(result)).toEqual([]);
      expect(merged(result)["a.txt"].bytes).toEqual(edited["a.txt"].bytes);
      expect(choices(result)).toEqual([
        {
          path: "a.txt",
          kind: "delete_modify",
          kept: localEdit ? "ours" : "theirs",
        },
      ]);
    },
  );

  test("invalid structured synthesis chooses the complete valid local file", () => {
    const base = "first: 1\nmiddle: 2\nlast: 3\n";
    const local = "first: 1\nextra: left\nmiddle: 2\nlast: 3\n";
    const remote = "first: 1\nmiddle: 2\nlast: 3\nextra: right\n";
    const result = merge(
      { "a.yaml": file(base) },
      { "a.yaml": file(local) },
      { "a.yaml": file(remote) },
      oursWins,
    );
    expect(conflicts(result)).toEqual([]);
    expect(merged(result)["a.yaml"].bytes).toEqual(file(local).bytes);
    expect(choices(result)).toEqual([{ path: "a.yaml", kind: "both_modified", kept: "ours" }]);
  });

  test("automatic binary overlap keeps the local bytes exactly", () => {
    const local = file(new Uint8Array([0, 255, 1]));
    const result = merge(
      {
        "asset.bin": file(new Uint8Array([0, 1, 2])),
      },
      { "asset.bin": local },
      {
        "asset.bin": file(new Uint8Array([0, 254, 2])),
      },
      oursWins,
    );
    expect(conflicts(result)).toEqual([]);
    expect(merged(result)["asset.bin"].bytes).toEqual(local.bytes);
    expect(choices(result)).toEqual([{ path: "asset.bin", kind: "binary", kept: "ours" }]);
  });

  test("reports descriptor, binary, and delete-modify conflicts without choosing a side", () => {
    const base = {
      "README.md": file("base"),
      "asset.bin": file(Uint8Array.of(0, 1)),
      "removed.txt": file("base"),
    };
    const result = merge(
      base,
      {
        "README.md": file("local"),
        "asset.bin": file(Uint8Array.of(0, 2)),
      },
      {
        "README.md": file("remote"),
        "asset.bin": file(Uint8Array.of(0, 3)),
        "removed.txt": file("remote"),
      },
    );
    expect(conflicts(result)).toEqual([
      { path: "README.md", kind: "descriptor" },
      { path: "asset.bin", kind: "binary" },
      { path: "removed.txt", kind: "delete_modify" },
    ]);
  });
});

describe("modes and trees", () => {
  const entry = (path: string, text: string, mode: 0o644 | 0o755 = 0o644) => ({
    path,
    kind: "file" as const,
    mode,
    bytes: new TextEncoder().encode(text),
  });

  test("a mode follows the side that changed it, even when the other side changed the bytes", () => {
    const result = Merge.runDecided(
      historyTree,
      {
        base: Option.some([entry("run.md", "echo 1\n")]),
        ours: Option.some([entry("run.md", "echo 2\n")]),
        theirs: Option.some([entry("run.md", "echo 1\n", 0o755)]),
      },
      () => "ours",
    );
    expect(result.value).toEqual(Option.some([entry("run.md", "echo 2\n", 0o755)]));
    expect(result.choices).toEqual([]);
  });

  test("edits to different lines of a script combine, whatever its extension", () => {
    const base = "#!/bin/sh\necho one\necho two\necho three\n";
    const result = Merge.run(historyTree, {
      base: Option.some([entry("run.sh", base, 0o755)]),
      ours: Option.some([entry("run.sh", base.replace("echo one", "echo first"), 0o755)]),
      theirs: Option.some([entry("run.sh", base.replace("echo three", "echo third"), 0o755)]),
    });
    expect(result._tag).toBe("Clean");
    expect(result._tag === "Clean" ? result.value : Option.none()).toEqual(
      Option.some([entry("run.sh", "#!/bin/sh\necho first\necho two\necho third\n", 0o755)]),
    );
  });

  test("a tree holding a symlink merges as one whole value", () => {
    const link = { path: "link", kind: "symlink" as const, target: "a.md" };
    const result = Merge.runDecided(
      historyTree,
      {
        base: Option.some([entry("a.md", "0")]),
        ours: Option.some([entry("a.md", "1")]),
        theirs: Option.some([entry("a.md", "0"), link]),
      },
      () => "theirs",
    );
    expect(result.value).toEqual(Option.some([entry("a.md", "0"), link]));
    expect(result.choices.map((choice) => choice.kept)).toEqual(["theirs"]);
  });
});
