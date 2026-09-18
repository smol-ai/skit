import {
  parseSkillFrontmatter,
  parseSkitConfig,
  parseSkitReadme,
  projectSkillFiles,
  type SkitDescriptor,
} from "@smolai/skit-core/universal/consumer";
import { Crypto, Effect, Schema } from "effect";
import { unzipSync, zipSync } from "fflate";

export const AGENT_SKILLS_DISCOVERY_SCHEMA =
  "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

const DISCOVERABLE_NAME = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;
const ARTIFACT_TIMESTAMP = Date.UTC(1980, 0, 1);

export interface DiscoverableSkill {
  readonly name: string;
  readonly description: string;
  readonly artifact: Uint8Array;
  readonly digest: `sha256:${string}`;
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
  const crypto = yield* Crypto.Crypto;
  const { descriptor, entries } = yield* attempt(() => {
    const files = unzipSync(release);
    return {
      descriptor: releaseDescriptor(files),
      entries: Object.entries(files).map(([path, bytes]) => ({ path, bytes })),
    };
  });
  const decoder = new TextDecoder();
  const skills: DiscoverableSkill[] = [];
  for (const skill of descriptor.skills) {
    if (!DISCOVERABLE_NAME.test(skill.name)) continue;
    const projected = yield* attempt(() => projectSkillFiles(entries, skill.path, skill.shared));
    const primary = projected.get("SKILL.md");
    if (!primary) continue;
    const frontmatter = yield* attempt(() => parseSkillFrontmatter(decoder.decode(primary.bytes)));
    const description = frontmatter?.description;
    if (typeof description !== "string" || !description || description.length > 1024) continue;
    const artifact = yield* attempt(() =>
      zipSync(
        Object.fromEntries(
          [...projected.keys()]
            .sort()
            .map((path) => [path, [projected.get(path)!.bytes, { mtime: ARTIFACT_TIMESTAMP }]]),
        ),
        { level: 0, mtime: ARTIFACT_TIMESTAMP },
      ),
    );
    const digest = yield* crypto.digest("SHA-256", artifact);
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    skills.push({ name: skill.name, description, artifact, digest: `sha256:${hex}` });
  }
  return skills;
});

export const agentSkillsIndex = (
  skills: readonly DiscoverableSkill[],
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
