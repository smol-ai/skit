import {
  parseSkillFrontmatter,
  parseSkitConfig,
  parseSkitReadme,
  projectSkillFiles,
  sha256Digest,
  type SkitDescriptor,
} from "@smolai/skit-core/universal/consumer";
import {
  MAX_PROJECTED_RELEASE_BYTES,
  MAX_PROJECTED_SKILL_BYTES,
} from "@smolai/skit-core/universal/authoring";
import { Effect, Schema } from "effect";
import { unzipSync, zipSync } from "fflate";

export const AGENT_SKILLS_DISCOVERY_SCHEMA =
  "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

const DISCOVERABLE_NAME = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;
const ARTIFACT_TIMESTAMP = Date.UTC(1980, 0, 1);

/** A Skill the Release can serve, with the files its archive would hold, not yet archived. */
export interface DiscoverableSkill {
  readonly name: string;
  readonly description: string;
  readonly files: ReadonlyMap<string, { readonly bytes: Uint8Array }>;
}

export class AgentSkillsArchiveInvalid extends Schema.TaggedError<AgentSkillsArchiveInvalid>()(
  "AgentSkills.ArchiveInvalid",
  { cause: Schema.Defect() },
) {}

const attempt = <A>(evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) => new AgentSkillsArchiveInvalid({ cause }),
  });

const releaseDescriptor = (files: Record<string, Uint8Array>): SkitDescriptor => {
  const decoder = new TextDecoder();
  if (files["skit.json"]) return parseSkitConfig(decoder.decode(files["skit.json"]));
  if (files["README.md"]) return parseSkitReadme(decoder.decode(files["README.md"]));
  throw new Error("DESCRIPTOR_MISSING");
};

export const discoverableSkills = Effect.fn("AgentSkills.discoverableSkills")(function* (
  release: Uint8Array,
) {
  const { descriptor, entries } = yield* attempt(() => {
    const files = unzipSync(release);
    return {
      descriptor: releaseDescriptor(files),
      entries: Object.entries(files).map(([path, bytes]) => ({ path, bytes })),
    };
  });
  const decoder = new TextDecoder();
  const skills: DiscoverableSkill[] = [];
  let releaseBytes = 0;
  for (const skill of descriptor.skills) {
    const projected = yield* Effect.fromResult(
      projectSkillFiles(entries, skill.path, skill.shared),
    ).pipe(Effect.mapError((cause) => new AgentSkillsArchiveInvalid({ cause })));
    // A Release published before projection limits may exceed them; serving it would build them.
    const skillBytes = [...projected.values()].reduce(
      (total, file) => total + file.bytes.byteLength,
      0,
    );
    releaseBytes += skillBytes;
    if (skillBytes > MAX_PROJECTED_SKILL_BYTES || releaseBytes > MAX_PROJECTED_RELEASE_BYTES)
      return yield* new AgentSkillsArchiveInvalid({ cause: "PROJECTED_CONTENT_TOO_LARGE" });
    if (!DISCOVERABLE_NAME.test(skill.name)) continue;
    const primary = projected.get("SKILL.md");
    if (!primary) continue;
    const frontmatter = yield* attempt(() => parseSkillFrontmatter(decoder.decode(primary.bytes)));
    const description = frontmatter?.description;
    if (typeof description !== "string" || !description || description.length > 1024) continue;
    skills.push({ name: skill.name, description, files: projected });
  }
  return skills;
});

/** One Skill's deterministic archive and its digest, built only when it is served or indexed. */
export const skillArtifact = Effect.fn("AgentSkills.skillArtifact")(function* (
  skill: DiscoverableSkill,
) {
  const artifact = yield* attempt(() =>
    zipSync(
      Object.fromEntries(
        [...skill.files.keys()]
          .sort()
          .map((path) => [path, [skill.files.get(path)!.bytes, { mtime: ARTIFACT_TIMESTAMP }]]),
      ),
      { level: 0, mtime: ARTIFACT_TIMESTAMP },
    ),
  );
  return { artifact, digest: yield* sha256Digest(artifact) };
});

export const agentSkillsIndex = (
  skills: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly digest: string;
  }>,
  artifactUrl: (name: string) => string,
) => ({
  $schema: AGENT_SKILLS_DISCOVERY_SCHEMA,
  skills: skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    type: "archive" as const,
    url: artifactUrl(skill.name),
    digest: skill.digest,
  })),
});
