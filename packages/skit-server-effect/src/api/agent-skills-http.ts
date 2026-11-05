import { sha256Hash } from "@smolai/skit-core/universal/consumer";
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { agentSkillsIndex, discoverableSkills, skillArtifact } from "../releases/agent-skills.js";
import { Skits } from "../skits/service.js";

const discoveryHeaders = { "cache-control": "public, no-cache" };

const jsonError = (error: string, status: number) =>
  HttpServerResponse.json({ error }, { status }).pipe(Effect.orDie);

const loadSkills = Effect.fn("AgentSkillsHttp.loadSkills")(function* (owner: string, slug: string) {
  const releases = (yield* Skits).releases;
  const release = yield* releases.findLatestPublic({ owner, slug });
  if (release === null) return yield* Effect.fail("not_found" as const);
  const archive = yield* release.archive.read;
  if (Option.isNone(archive)) return yield* Effect.fail("not_found" as const);
  return yield* discoverableSkills(archive.value);
});

const routeParams = Effect.map(HttpRouter.RouteContext, ({ params }) => ({
  owner: params.owner ?? "",
  slug: params.slug ?? "",
  skill: params.skill,
}));

export const indexResponse = Effect.gen(function* () {
  const { owner, slug } = yield* routeParams;
  const skills = yield* loadSkills(owner, slug);
  // One archive at a time: each is hashed and released before the next is built.
  const indexed = yield* Effect.forEach(skills, (skill) =>
    skillArtifact(skill).pipe(
      Effect.flatMap(sha256Hash),
      Effect.map((digest) => ({ ...skill, digest })),
    ),
  );
  return yield* HttpServerResponse.json(
    agentSkillsIndex(indexed, (name) => `/${owner}/${slug}/skills/${name}/skill.zip`),
    { headers: discoveryHeaders },
  );
}).pipe(
  Effect.catchTag("AgentSkills.ArchiveInvalid", () => jsonError("not_found", 404)),
  Effect.catch((error) =>
    error === "not_found"
      ? jsonError("not_found", 404)
      : Effect.logError("Agent Skills discovery failed", error).pipe(
          Effect.andThen(jsonError("storage_failure", 500)),
        ),
  ),
);

export const artifactResponse = Effect.gen(function* () {
  const { owner, slug, skill } = yield* routeParams;
  const skills = yield* loadSkills(owner, slug);
  const selected = skills.find((candidate) => candidate.name === skill);
  if (selected === undefined) return yield* Effect.fail("not_found" as const);
  const artifact = yield* skillArtifact(selected);
  return HttpServerResponse.uint8Array(artifact, {
    contentType: "application/zip",
    headers: discoveryHeaders,
  });
}).pipe(
  Effect.catchTag("AgentSkills.ArchiveInvalid", () => jsonError("not_found", 404)),
  Effect.catch((error) =>
    error === "not_found"
      ? jsonError("not_found", 404)
      : Effect.logError("Agent Skills artifact failed", error).pipe(
          Effect.andThen(jsonError("storage_failure", 500)),
        ),
  ),
);
