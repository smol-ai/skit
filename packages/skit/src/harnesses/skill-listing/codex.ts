import { Effect, FileSystem, Option, Schema } from "effect";
import { dirname, join, resolve } from "node:path";
import { modelContextWindow } from "../../models/model-context-windows.js";
import type { LibraryState } from "../../library/library-state.js";
import type { SkillsDirectoryOverrides } from "../contracts.js";
import { invocationMetadataAdapters } from "../invocation-metadata.js";
import { estimateCodexListing, type CodexListingSkill } from "./codex-allocation.js";
import type { ListingBudget } from "./contracts.js";
import { readCodexSkills } from "./codex-discovery.js";

export interface CodexListingOptions {
  readonly cwd: string;
  readonly overrides?: SkillsDirectoryOverrides;
}

const Configuration = Schema.Struct({
  config: Schema.Struct({
    model: Schema.optionalKey(Schema.NullOr(Schema.String)),
    model_context_window: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    skills: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({ max_context_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)) }),
      ),
    ),
  }),
});
const positive = (value: number | null | undefined): number | null =>
  value !== undefined && value !== null && Number.isSafeInteger(value) && value > 0 ? value : null;

/** Whether Codex may list the Skill for implicit invocation, as its own metadata states. */
export const implicitInvocationAllowed = Effect.fn("CodexListing.implicitInvocationAllowed")(
  function* (path: string) {
    const fs = yield* FileSystem.FileSystem;
    const adapter = invocationMetadataAdapters.codex;
    const metadataPath = join(dirname(path), ...adapter.file.split("/"));
    const text = (yield* fs.exists(metadataPath))
      ? yield* fs.readFileString(metadataPath)
      : undefined;
    return (yield* Effect.fromResult(adapter.read(text, metadataPath))) !== "explicit";
  },
);

/** Read-only native discovery, configuration and local model catalog; never starts an inference turn. */
export const readCodexListingBudget = Effect.fn("Library.codexListingBudget")(function* (
  state: LibraryState,
  options: CodexListingOptions,
  executable?: string,
  suppliedDiscovery?: Effect.Success<ReturnType<typeof readCodexSkills>>,
) {
  const unavailable = (detail: string): ListingBudget => ({
    _tag: "Unavailable",
    harness: "codex",
    cwd: options.cwd,
    detail,
  });
  if (options.overrides?.codex !== undefined)
    return unavailable("A custom Codex root does not describe native discovery.");
  return yield* Effect.gen(function* () {
    const command = executable ?? "codex";
    const discovery =
      suppliedDiscovery ?? (yield* readCodexSkills(command, options.cwd, undefined, true));
    if (discovery.configError !== undefined) return unavailable(discovery.configError);
    const configuration = yield* Schema.decodeUnknownEffect(Configuration)(discovery.config);
    const fs = yield* FileSystem.FileSystem;
    const model = configuration.config.model ?? null;
    const contextWindow =
      positive(configuration.config.model_context_window) ??
      Option.getOrNull(modelContextWindow("openai", model));
    const collectionsByPath = new Map<string, string>();
    for (const projection of state.projections.filter(
      (projection) => projection.target === "agents" && projection.suppression_reason === undefined,
    )) {
      const skill = state.skills.find((skill) => skill.skill_id === projection.skill_id);
      if (skill === undefined) continue;
      const path = yield* fs
        .realPath(join(projection.path, "SKILL.md"))
        .pipe(Effect.orElseSucceed(() => resolve(projection.path, "SKILL.md")));
      collectionsByPath.set(path, skill.collection_id);
    }
    const seen = new Set<string>();
    const skills: CodexListingSkill[] = [];
    for (const skill of discovery.skills.filter((skill) => skill.enabled)) {
      const canonical = yield* fs.realPath(skill.path);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      if (!(yield* implicitInvocationAllowed(skill.path))) continue;
      if (skill.description === undefined)
        return unavailable("This Codex version does not provide skill descriptions.");
      const collectionId = collectionsByPath.get(canonical);
      skills.push({
        name: skill.name,
        description: skill.description,
        path: skill.path,
        scope: skill.scope,
        ...(collectionId === undefined ? {} : { collectionId }),
      });
    }
    const maxContextTokens = positive(configuration.config.skills?.max_context_tokens);
    return estimateCodexListing({
      cwd: options.cwd,
      model,
      contextWindow,
      ...(maxContextTokens === null ? {} : { maxContextTokens }),
      skills,
      warnings: discovery.errors.map((error) => `Skipped skill ${error.path}: ${error.message}`),
    });
  }).pipe(Effect.catch((error) => Effect.succeed(unavailable(String(error)))));
});
