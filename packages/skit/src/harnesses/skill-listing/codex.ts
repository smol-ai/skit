import { Effect, FileSystem, Option, Schema } from "effect";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { modelContextWindow } from "../../models/model-context-windows.js";
import type { LibraryState } from "../../library/library-state.js";
import {
  CodexListingBudget,
  estimateCodexListing,
  type CodexSkillDemand,
  type CodexListingSkill,
} from "./codex-allocation.js";
import { CodexDoctorFailure, readCodexSkills } from "./codex-discovery.js";

export interface CodexListingOptions {
  readonly cwd: string;
  readonly home: string;
  readonly overrideRoot?: string;
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
const MetadataPolicy = Schema.Struct({
  policy: Schema.optionalKey(
    Schema.Struct({ allow_implicit_invocation: Schema.optionalKey(Schema.Boolean) }),
  ),
});
const positive = (value: number | null | undefined): number | null =>
  value !== undefined && value !== null && Number.isSafeInteger(value) && value > 0 ? value : null;

export const implicitInvocationAllowed = Effect.fn("CodexListing.implicitInvocationAllowed")(
  function* (path: string) {
    const fs = yield* FileSystem.FileSystem;
    // SKILL.json is the current metadata source; agents/openai.yaml supports existing installations.
    for (const metadataPath of [
      join(dirname(path), "SKILL.json"),
      join(dirname(path), "agents", "openai.yaml"),
    ]) {
      if (!(yield* fs.exists(metadataPath))) continue;
      const content = yield* fs.readFileString(metadataPath);
      const document = yield* Effect.try({
        try: () => parseDocument(content),
        catch: (error) =>
          new CodexDoctorFailure({
            message: `Cannot read invocation policy at ${metadataPath}: ${String(error)}`,
          }),
      });
      if (document.errors.length)
        return yield* new CodexDoctorFailure({
          message: `Cannot read invocation policy at ${metadataPath}`,
        });
      const value = yield* Effect.try({
        try: () => document.toJS(),
        catch: (error) =>
          new CodexDoctorFailure({
            message: `Cannot read invocation policy at ${metadataPath}: ${String(error)}`,
          }),
      });
      const metadata = yield* Schema.decodeUnknownEffect(MetadataPolicy)(value);
      return metadata.policy?.allow_implicit_invocation !== false;
    }
    return true;
  },
);

/** Read-only native discovery, configuration and local model catalog; never starts an inference turn. */
export const readLibraryCodexListingSnapshot = Effect.fn("Library.codexListingSnapshot")(function* (
  state: LibraryState,
  options: CodexListingOptions,
  executable?: string,
  suppliedDiscovery?: Effect.Success<ReturnType<typeof readCodexSkills>>,
) {
  const unavailable = (detail: string): CodexListingSnapshot => ({
    budget: { status: "unavailable", cwd: options.cwd, detail },
    skills: [],
    skillDemands: [],
  });
  if (options.overrideRoot !== undefined)
    return unavailable("A custom Codex root does not describe native discovery.");
  return yield* Effect.gen(function* () {
    const command = executable ?? "codex";
    const discovery =
      suppliedDiscovery ?? (yield* readCodexSkills(command, options.cwd, undefined, true));
    if (discovery.configError !== undefined) return unavailable(discovery.configError);
    if (discovery.errors.length)
      return unavailable(
        `Codex discovery is incomplete: ${discovery.errors.map((error) => error.message).join("; ")}`,
      );
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
    const estimate = estimateCodexListing({
      cwd: options.cwd,
      model,
      contextWindow,
      ...(maxContextTokens === null ? {} : { maxContextTokens }),
      skills,
    });
    return {
      skills,
      skillDemands: estimate.skills,
      ...(maxContextTokens === null ? {} : { maxContextTokens }),
      budget: estimate.budget,
    } satisfies CodexListingSnapshot;
  }).pipe(Effect.catch((error) => Effect.succeed(unavailable(String(error)))));
});

export interface CodexListingSnapshot {
  readonly budget: CodexListingBudget;
  readonly skills: readonly CodexListingSkill[];
  readonly maxContextTokens?: number;
  readonly skillDemands?: readonly CodexSkillDemand[];
}

export const readLibraryCodexListingBudget = Effect.fn("Library.codexListingBudget")(function* (
  state: LibraryState,
  options: CodexListingOptions,
  executable?: string,
) {
  return (yield* readLibraryCodexListingSnapshot(state, options, executable)).budget;
});
