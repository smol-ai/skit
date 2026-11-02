/**
 * Merging a tree of files: each file on its own, folded along skill renames, with text merged
 * line by line and SKILL.md frontmatter merged field by field.
 */
import { Equal, Option, Record, Schema } from "effect";
import { parseDocument } from "yaml";
import { parseSkillFrontmatter } from "../harnesses/frontmatter.js";
import { SyncFileVersion, type SyncConflict } from "../contracts.js";
import type { YamlMapping } from "../shared/json.js";
import { decodeUtf8 } from "../shared/text.js";
import * as History from "../history/history.js";
import * as Merge from "./merge.js";
import { followSkillMoves } from "./skill-moves.js";

export type Files = Readonly<Record<string, SyncFileVersion>>;

/** Files are the same when their bytes and modes are. */
const sameFile = Schema.toEquivalence(SyncFileVersion);
const wholeFile = Merge.whole(sameFile);

/**
 * The file as text, or none for binary content: bytes holding NUL, as git decides, or bytes
 * that are not valid UTF-8.
 */
const textOf = (file: SyncFileVersion) =>
  file.bytes.includes(0) ? Option.none() : decodeUtf8(file.bytes);

const isSkillFile = (path: string) => path.split("/").at(-1) === "SKILL.md";

/** Whether merged text still parses; authored files that never parsed are not checked. */
const parses = (path: string, text: string): boolean => {
  if (isSkillFile(path)) return parseSkillFrontmatter(text) !== null;
  if (path.endsWith(".json")) return Option.isSome(Option.liftThrowable(JSON.parse)(text));
  if (/\.ya?ml$/u.test(path)) return parseDocument(text).errors.length === 0;
  return true;
};

/** SKILL.md as its parsed frontmatter and its body. */
interface SkillFile {
  readonly frontmatter: YamlMapping;
  readonly body: string;
}

/** SKILL.md split at its frontmatter fences, keeping the fences and raw YAML for re-encoding. */
interface SplitSkill extends SkillFile {
  readonly open: string;
  readonly yaml: string;
  readonly close: string;
}

const splitSkill = (text: string): Option.Option<SplitSkill> => {
  const match = text.match(/^(---\r?\n)(?:([\s\S]*?)(\r?\n))?(---(?:\r?\n|$))/u);
  if (match === null) return Option.none();
  const [fenced, open = "", yaml = "", , close = ""] = match;
  const document = parseDocument(yaml);
  if (document.errors.length > 0) return Option.none();
  return Option.map(
    Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(
      yaml.trim() === "" ? {} : document.toJS(),
    ),
    (frontmatter) => ({ open, yaml, close, body: text.slice(fenced.length), frontmatter }),
  );
};

/** Parsed YAML values compare by content, not by formatting. */
const sameValue = Equal.asEquivalence<unknown>();

/**
 * Write merged frontmatter into our YAML document, so its comments, key order and quoting
 * survive; only the fields that changed are rewritten.
 */
const joinSkill = (merged: SkillFile, own: SplitSkill) => {
  const rewrite = () => {
    const document = parseDocument(own.yaml);
    for (const key of Object.keys(own.frontmatter))
      if (!Object.hasOwn(merged.frontmatter, key)) document.delete(key);
    for (const [key, value] of Object.entries(merged.frontmatter))
      if (!sameValue(own.frontmatter[key], value)) document.set(key, value);
    return document.toString().replace(/\n$/u, "");
  };
  const yaml = sameValue(merged.frontmatter, own.frontmatter) ? own.yaml : rewrite();
  const newline = own.open.endsWith("\r\n") ? "\r\n" : "\n";
  return `${own.open}${yaml === "" ? "" : `${yaml}${newline}`}${own.close}${merged.body}`;
};

/**
 * SKILL.md frontmatter, field by field. `name` is the skill's identity and merges as a whole
 * value like any other field (to decide with swyx); the losing name is kept with its choice.
 * `allowed-tools` merges as a set and `metadata` key by key only while every side holds a list
 * or a mapping; any other value there, like the string form `allowed-tools: Read, Grep`, is
 * one whole value.
 */
const frontmatter = Merge.record(Merge.whole(sameValue), {
  "allowed-tools": Merge.via<unknown, ReadonlyArray<unknown>>(
    { decode: Schema.decodeUnknownOption(Schema.Array(Schema.Unknown)), encode: (tools) => tools },
    Merge.set(sameValue),
    Merge.whole(sameValue),
  ),
  metadata: Merge.via<unknown, YamlMapping>(
    {
      decode: Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown)),
      encode: (fields) => fields,
    },
    Merge.record(Merge.whole(sameValue)),
    Merge.whole(sameValue),
  ),
});

/** SKILL.md: frontmatter field by field and the body line by line, or all lines when unparseable. */
const skillText = Merge.via<string, SkillFile, SplitSkill>(
  { decode: splitSkill, encode: joinSkill },
  Merge.struct<SkillFile>({ frontmatter, body: Merge.lines }),
  Merge.lines,
);

/**
 * One file, named by the last step of where it is. Text merges line by line; README.md and
 * binary files are whole values. A text merge that would break the syntax of two valid inputs
 * is a whole-file conflict instead.
 */
const file: Merge.Merger<SyncFileVersion> = Merge.make(
  sameFile,
  (base, ours, theirs, at, choose) => {
    const whole = () =>
      wholeFile({ base, ours: Option.some(ours), theirs: Option.some(theirs) }, at, choose);
    const path = String(at.at(-1));
    const texts = Option.all({
      base: Option.flatMap(base, textOf),
      ours: textOf(ours),
      theirs: textOf(theirs),
    });
    if (path === "README.md" || Option.isNone(texts)) return whole();
    const merged = (isSkillFile(path) ? skillText : Merge.lines)(
      {
        base: Option.some(texts.value.base),
        ours: Option.some(texts.value.ours),
        theirs: Option.some(texts.value.theirs),
      },
      at,
      choose,
    );
    const text = Option.getOrElse(merged.value, () => texts.value.ours);
    if (!parses(path, text) && parses(path, texts.value.ours) && parses(path, texts.value.theirs))
      return whole();
    // A mode follows the side that changed it.
    const mode = Option.exists(base, (file) => file.mode === ours.mode) ? theirs.mode : ours.mode;
    return { ...merged, value: Option.some({ bytes: new TextEncoder().encode(text), mode }) };
  },
);

/** A tree of files by path. Files follow a skill folder one side renamed. */
export const fileTree: Merge.Merger<Files> = (versions, at, choose) => {
  const aligned = followSkillMoves({
    base: Option.getOrElse(versions.base, Record.empty),
    ours: Option.getOrElse(versions.ours, Record.empty),
    theirs: Option.getOrElse(versions.theirs, Record.empty),
  });
  return Merge.record(file)(
    {
      base: Option.some(aligned.base),
      ours: Option.some(aligned.ours),
      theirs: Option.some(aligned.theirs),
    },
    at,
    choose,
  );
};

/**
 * A {@link History.Tree}, merged file by file as {@link fileTree}. A tree that holds a directory
 * or symlink is one whole value instead, so nothing in it is merged away.
 */
export const historyTree: Merge.Merger<History.Tree> = Merge.via<History.Tree, Files>(
  {
    decode: (tree) =>
      Option.map(
        Option.all(
          tree.map((entry) =>
            entry.kind === "file"
              ? Option.some([entry.path, { bytes: entry.bytes, mode: entry.mode }] as const)
              : Option.none(),
          ),
        ),
        Record.fromEntries,
      ),
    encode: (files) =>
      Object.entries(files).map(([path, file]) => ({
        path,
        kind: "file" as const,
        mode: file.mode,
        bytes: file.bytes,
      })),
  },
  fileTree,
  Merge.whole(Schema.toEquivalence(History.Tree)),
);

/** What kind of conflict a file tree merge met, for people and the Registry. */
export const conflictKind = (found: Merge.Conflict): SyncConflict["kind"] => {
  // A line or field inside a file; a whole-file conflict sits at the file's own path.
  if (found.at.length > 1) return "both_modified";
  if (Option.isNone(found.ours) || Option.isNone(found.theirs)) return "delete_modify";
  // A whole tree that held something other than files.
  if (found.at.length === 0) return "both_modified";
  if (found.at[0] === "README.md") return "descriptor";
  const text = (side: Option.Option<unknown>) =>
    Option.isSome(Option.flatMap(Option.filter(side, Schema.is(SyncFileVersion)), textOf));
  return text(found.ours) && text(found.theirs) ? "both_modified" : "binary";
};
