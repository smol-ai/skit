import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { r2BodyEffect } from "../platform/cloudflare.js";
import { agentSkillsIndex, discoverableSkills } from "./agent-skills.js";
import { ReleaseStore } from "./store.js";

const discoveryHeaders = { "cache-control": "public, no-cache" };

const jsonError = (error: string, status: number) =>
  HttpServerResponse.json({ error }, { status }).pipe(Effect.orDie);

const loadSkills = Effect.fn("AgentSkillsHttp.loadSkills")(function* (owner: string, slug: string) {
  const store = yield* ReleaseStore;
  const release = yield* store.findLatestPublic({ owner, slug });
  if (release === null) return yield* Effect.fail("not_found" as const);
  const archive = yield* store.readArchive(release.archive_object_key);
  if (archive === null) return yield* Effect.fail("not_found" as const);
  const bytes = yield* r2BodyEffect("read Agent Skills release archive", () =>
    archive.arrayBuffer(),
  );
  return yield* discoverableSkills(new Uint8Array(bytes));
});

const routeParams = Effect.map(HttpRouter.RouteContext, ({ params }) => ({
  owner: params.owner ?? "",
  slug: params.slug ?? "",
  skill: params.skill,
}));

export const indexResponse = Effect.gen(function* () {
  const { owner, slug } = yield* routeParams;
  const skills = yield* loadSkills(owner, slug);
  return yield* HttpServerResponse.json(
    agentSkillsIndex(skills, (name) => `/${owner}/${slug}/skills/${name}/skill.zip`),
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
  return HttpServerResponse.uint8Array(selected.artifact, {
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
