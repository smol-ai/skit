import {
  parseSkillFrontmatter,
  parseSkitConfig,
  parseSkitReadme,
  projectSkillFiles,
} from "@smolai/skit-core/universal/consumer";
import { Effect, Schema } from "effect";
import { unzipSync, zipSync } from "fflate";
import { projectionLimitExceeded } from "../integrity/projection-limits.js";

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

const releaseDescriptor = Effect.fn("AgentSkills.releaseDescriptor")(function* (
  files: Record<string, Uint8Array>,
) {
  const decoder = new TextDecoder();
  if (files["skit.json"]) return yield* parseSkitConfig(decoder.decode(files["skit.json"]));
  if (files["README.md"]) return yield* parseSkitReadme(decoder.decode(files["README.md"]));
  return yield* Effect.fail("DESCRIPTOR_MISSING");
});

export const discoverableSkills = Effect.fn("AgentSkills.discoverableSkills")(function* (
  release: Uint8Array,
) {
  const files = yield* attempt(() => unzipSync(release));
  const descriptor = yield* releaseDescriptor(files).pipe(
    Effect.mapError((cause) => new AgentSkillsArchiveInvalid({ cause })),
  );
  const entries = Object.entries(files).map(([path, bytes]) => ({ path, bytes }));
  // A Release published before projection limits may exceed them; serving it would build them.
  if (projectionLimitExceeded(entries, descriptor.skills))
    return yield* new AgentSkillsArchiveInvalid({ cause: "PROJECTED_CONTENT_TOO_LARGE" });
  const decoder = new TextDecoder();
  const skills: DiscoverableSkill[] = [];
  for (const skill of descriptor.skills) {
    if (!DISCOVERABLE_NAME.test(skill.name)) continue;
    const projected = yield* Effect.fromResult(
      projectSkillFiles(entries, skill.path, skill.shared),
    ).pipe(Effect.mapError((cause) => new AgentSkillsArchiveInvalid({ cause })));
    const primary = projected.get("SKILL.md");
    if (!primary) continue;
    const frontmatter = yield* attempt(() => parseSkillFrontmatter(decoder.decode(primary.bytes)));
    const description = frontmatter?.description;
    if (typeof description !== "string" || !description || description.length > 1024) continue;
    skills.push({ name: skill.name, description, files: projected });
  }
  return skills;
});

/** One Skill's deterministic archive, built only when it is served or indexed. */
export const skillArtifact = (skill: DiscoverableSkill) =>
  attempt(() =>
    zipSync(
      Object.fromEntries(
        [...skill.files.keys()]
          .sort()
          .map((path) => [path, [skill.files.get(path)!.bytes, { mtime: ARTIFACT_TIMESTAMP }]]),
      ),
      { level: 0, mtime: ARTIFACT_TIMESTAMP },
    ),
  );

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
