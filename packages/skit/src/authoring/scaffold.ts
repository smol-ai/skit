import { Effect, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { DescriptorFailure } from "../failures.js";
import { DuplicateSkillNames, SkillDiscoveryLimitExceeded, SkillNameInvalid } from "../failures.js";
import { parseSkillFrontmatter } from "../harnesses/frontmatter.js";
import { writeRawAtomicEffect } from "../platform/atomic-write.js";
import { LinkStat } from "../platform/link-stat.js";
import { readSkitDescriptorEffect } from "../artifact/skit.js";
import { kebabNameSchema } from "../schemas.js";

const isKebabName = Schema.is(kebabNameSchema);

function discoverSkills(
  root: string,
): Effect.Effect<
  Array<{ name: string; path: string }>,
  SkillDiscoveryLimitExceeded | SkillNameInvalid | PlatformError,
  FileSystem.FileSystem | LinkStat
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const probe = yield* LinkStat;
    const queue = [root];
    const skills: Array<{ name: string; path: string }> = [];
    let examined = 0;
    while (queue.length) {
      const directory = queue.shift()!;
      examined++;
      if (examined > 5_000) return yield* new SkillDiscoveryLimitExceeded({ limit: 5_000 });
      const names = yield* fs.readDirectory(directory);
      // Dirent reflects lstat: a symlinked directory is not a directory, so discovery cannot
      // follow links out of the root or around a cycle. fs.stat would follow them.
      const entries = yield* Effect.forEach(names, (name) =>
        probe.identity.lstat(join(directory, name)).pipe(Effect.map((info) => ({ name, info }))),
      );
      const skillFile = entries.find(
        (entry) => entry.info.type === "File" && entry.name === "SKILL.md",
      );
      if (skillFile) {
        const fields = parseSkillFrontmatter(
          yield* fs.readFileString(join(directory, skillFile.name)),
        );
        if (!fields || typeof fields.name !== "string" || !isKebabName(fields.name))
          return yield* new SkillNameInvalid({
            path: relative(root, join(directory, skillFile.name)),
          });
        skills.push({
          name: fields.name,
          path: relative(root, directory).split(sep).join("/") || ".",
        });
        continue;
      }
      for (const entry of entries)
        if (
          entry.info.type === "Directory" &&
          entry.name !== "node_modules" &&
          entry.name !== ".git" &&
          !entry.name.startsWith(".")
        )
          queue.push(join(directory, entry.name));
    }
    return skills.sort((left, right) => left.path.localeCompare(right.path));
  });
}

/** Only the entry count is read, so the schema states exactly that much. */
const SkillsLock = Schema.fromJsonString(
  Schema.Struct({ skills: Schema.Record(Schema.String, Schema.Unknown) }),
);

const decodeSkillsLock = Schema.decodeUnknownEffect(SkillsLock);

export interface InitSkitResult {
  path: string;
  discovered: {
    skills: number;
    skillEntries: Array<{ name: string; path: string }>;
    readme: boolean;
    git: boolean;
    skillsLock: { present: boolean; entries: number };
  };
}

function initDiscovery(
  root: string,
  skills: Array<{ name: string; path: string }>,
): Effect.Effect<InitSkitResult["discovered"], PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lockPath = join(root, "skills-lock.json");
    const lockPresent = yield* fs.exists(lockPath);
    let lockEntries = 0;
    if (lockPresent) {
      // The skills.sh lock is adjacent consumption state; initialization preserves it verbatim
      // and never fails on it. Anything that will not decode reports zero entries.
      const lock = yield* Effect.option(
        fs.readFileString(lockPath).pipe(Effect.flatMap(decodeSkillsLock)),
      );
      if (lock._tag === "Some") lockEntries = Object.keys(lock.value.skills).length;
    }
    return {
      // Retained for wire compatibility; skillEntries is the authoritative discovered collection.
      skills: skills.length,
      skillEntries: skills,
      readme: yield* fs.exists(join(root, "README.md")),
      git: yield* fs.exists(join(root, ".git")),
      skillsLock: { present: lockPresent, entries: lockEntries },
    };
  });
}

const createScaffoldFileEffect = Effect.fn("Author.createScaffoldFile")(function* (
  path: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(path), { recursive: true });
  yield* writeRawAtomicEffect(path, contents, true, 0o644).pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
    ),
  );
});

const completeScaffoldEffect = Effect.fn("Author.completeScaffold")(function* (
  root: string,
  slug: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const config = {
    slug,
    skills: [
      {
        name: slug,
        path: `skills/${slug}`,
        default_enabled: true,
        invocation: "explicit",
        capabilities: ["filesystem_read"],
      },
    ],
  };
  // The Skill conforms even when installed directly, without SKIT.
  const skill = `---\nname: ${slug}\ndescription: Describe exactly when this skill should be used.\ndisable-model-invocation: true\n---\n\n# ${slug}\n\nAdd instructions here.\n`;
  yield* createScaffoldFileEffect(
    join(root, "skills", slug, "agents", "openai.yaml"),
    "policy:\n  allow_implicit_invocation: false\n",
  );
  yield* createScaffoldFileEffect(join(root, "skills", slug, "SKILL.md"), skill);
  yield* createScaffoldFileEffect(join(root, "README.md"), `# ${slug}\n`);
  yield* createScaffoldFileEffect(join(root, "skit.json"), `${JSON.stringify(config, null, 2)}\n`);
  yield* fs.remove(join(root, ".skit", "init-scaffold")).pipe(Effect.uninterruptible);
});

export const initSkitEffect = Effect.fn("Author.initScaffold")(function* (
  path: string,
): Effect.fn.Return<
  InitSkitResult,
  | DescriptorFailure
  | DuplicateSkillNames
  | SkillDiscoveryLimitExceeded
  | SkillNameInvalid
  | PlatformError,
  FileSystem.FileSystem | LinkStat
> {
  const fs = yield* FileSystem.FileSystem;
  const root = resolve(path);
  yield* fs.makeDirectory(root, { recursive: true });
  const checkpointPath = join(root, ".skit", "init-scaffold");
  const checkpoint = yield* fs
    .readFileString(checkpointPath)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  if (checkpoint !== undefined && !isKebabName(checkpoint))
    return yield* new SkillNameInvalid({ path: checkpointPath });
  const existingSkills = yield* discoverSkills(root);
  if (new Set(existingSkills.map((skill) => skill.name)).size !== existingSkills.length)
    return yield* new DuplicateSkillNames();
  const discovered = yield* initDiscovery(root, existingSkills);
  if (checkpoint !== undefined) {
    yield* completeScaffoldEffect(root, checkpoint);
    return { path: root, discovered };
  }
  if (yield* fs.exists(join(root, "skit.json"))) return { path: root, discovered };
  const readmePath = join(root, "README.md");
  if (yield* fs.exists(readmePath)) {
    const readme = yield* fs.readFileString(readmePath);
    if (/^---\r?\n[\s\S]*?^skit:\s*1\s*$/m.test(readme)) {
      yield* readSkitDescriptorEffect(root);
      return { path: root, discovered };
    }
  }
  const slug =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "my-skit";
  if (existingSkills.length) {
    yield* writeRawAtomicEffect(
      join(root, "skit.json"),
      `${JSON.stringify({ slug, skills: existingSkills }, null, 2)}\n`,
      true,
      0o644,
    );
    return { path: root, discovered };
  }
  yield* writeRawAtomicEffect(checkpointPath, slug, true);
  yield* completeScaffoldEffect(root, slug);
  return { path: root, discovered };
});
