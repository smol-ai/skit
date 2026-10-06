import { Schema } from "effect";
import { harnessProfile } from "@smolai/skit-core";

const Contribution = Schema.Struct({
  collectionId: Schema.String,
  skills: Schema.Number,
  used: Schema.Number,
  requested: Schema.Number,
  shortened: Schema.Number,
  omitted: Schema.Number,
});

export const CodexListingBudget = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    cwd: Schema.String,
    detail: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("estimated"),
    cwd: Schema.String,
    model: Schema.NullOr(Schema.String),
    contextWindow: Schema.NullOr(Schema.Number),
    unit: Schema.Literals(["budget-tokens", "characters"]),
    limit: Schema.Number,
    used: Schema.Number,
    requested: Schema.Number,
    sharedOverhead: Schema.Number,
    otherSkills: Schema.Number,
    shortened: Schema.Number,
    omitted: Schema.Number,
    collections: Schema.Array(Contribution),
  }),
]);
export type CodexListingBudget = typeof CodexListingBudget.Type;

export interface CodexListingSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly scope: string;
  readonly collectionId?: string;
}

// Codex 0.160.1 ext/skills/src/{render,catalog_prompt}.rs. These count listing metadata only.
const absoluteIntro =
  "A skill is a set of instructions provided through a `SKILL.md` source. Below is the list of skills that can be used. Each entry includes a name, description, and source locator. `file` locators are on the host filesystem, `executor package` locators are owned by their execution environment, `cloud package` locators are opaque package identifiers, and `custom resource` locators use their provider's access mechanism.";
const aliasedIntro =
  "A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and a short path that can be expanded into an absolute path using the skill roots table.";
const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;
const scopeRank = (scope: string): number =>
  ({ system: 0, admin: 1, repo: 2, user: 3 })[scope] ?? 4;

/** Estimated metadata roots; native skills/list does not expose the renderer's alias plan. */
function rootsFor(skills: readonly CodexListingSkill[]): string[] {
  const roots = skills.map((skill) => {
    const plugin = skill.path.match(/^(.*\/plugins\/cache\/[^/]+)\/([^/]+)\/([^/]+)\/skills\//);
    if (plugin) {
      const version = `${plugin[1]}/${plugin[2]}/${plugin[3]}`;
      const siblings = skills.filter((other) => other.path.startsWith(`${version}/skills/`));
      return siblings.length > 1 ? `${version}/skills` : plugin[1];
    }
    return skill.path.match(/^(.*\/(?:\.agents\/skills|\.codex\/skills(?:\/\.system)?))\//)?.[1];
  });
  return [...new Set(roots.filter((root): root is string => root !== undefined))];
}

export interface CodexListingEstimateInput {
  readonly cwd: string;
  readonly model: string | null;
  readonly contextWindow: number | null;
  readonly maxContextTokens?: number;
  readonly skills: readonly CodexListingSkill[];
}

export interface CodexSkillDemand {
  readonly name: string;
  readonly path: string;
  readonly requested: number;
}

export function estimateCodexListing(input: CodexListingEstimateInput): {
  readonly budget: Extract<CodexListingBudget, { status: "estimated" }>;
  readonly skills: readonly CodexSkillDemand[];
} {
  const contract = harnessProfile("codex").skillListing!;
  const unit =
    input.maxContextTokens !== undefined || input.contextWindow !== null
      ? "budget-tokens"
      : "characters";
  const limit =
    input.maxContextTokens !== undefined
      ? Math.min(input.maxContextTokens, 10_000)
      : input.contextWindow === null
        ? contract.fallbackCharacters!
        : Math.max(1, Math.floor(input.contextWindow * contract.fraction));
  const cost = (text: string): number =>
    unit === "budget-tokens" ? Math.ceil(bytes(text) / 4) : Array.from(text).length;
  const skills = [...input.skills].sort(
    (a, b) =>
      scopeRank(a.scope) - scopeRank(b.scope) ||
      a.name.localeCompare(b.name) ||
      a.path.localeCompare(b.path),
  );
  const roots = rootsFor(skills);
  const descriptions = skills.map((skill) => {
    const chars = Array.from(skill.description);
    return chars.length > contract.descriptionCap
      ? [...chars.slice(0, contract.descriptionCap - 3), ".", ".", "."]
      : chars;
  });
  const render = (index: number, count: number, aliased: boolean): string => {
    const skill = skills[index]!;
    const root = aliased
      ? roots
          .filter((root) => skill.path.startsWith(`${root}/`))
          .sort((a, b) => b.length - a.length)[0]
      : undefined;
    const path =
      root === undefined
        ? skill.path
        : `r${roots.indexOf(root)}/${skill.path.slice(root.length + 1)}`;
    const description = descriptions[index]!.slice(0, count).join("");
    return `- ${skill.name}: ${description ? `${description} ` : ""}(file: ${path})\n`;
  };
  const allocate = (aliased: boolean) => {
    const overhead = aliased
      ? Math.max(
          0,
          cost(
            `\n## Skills\n${aliasedIntro}\n### Skill roots\n${roots.map((root, index) => `- \`r${index}\` = \`${root}\``).join("\n")}\n### Available skills\n`,
          ) - cost(`\n## Skills\n${absoluteIntro}\n### Available skills\n`),
        )
      : 0;
    const available = Math.max(0, limit - overhead);
    const counts = descriptions.map((chars) => chars.length);
    const full = counts.map((count, index) => cost(render(index, count, aliased)));
    const minimum = counts.map((_, index) => cost(render(index, 0, aliased)));
    if (full.reduce((a, b) => a + b, 0) > available) {
      counts.fill(0);
      let remaining = available - minimum.reduce((a, b) => a + b, 0);
      if (remaining < 0) {
        remaining = available;
        for (let index = 0; index < counts.length; index++) {
          if (minimum[index]! <= remaining) remaining -= minimum[index]!;
          else counts[index] = -1;
        }
      } else {
        // Codex distributes description characters round-robin.
        let changed = true;
        while (changed) {
          changed = false;
          for (let index = 0; index < counts.length; index++) {
            const count = counts[index]!;
            if (count >= descriptions[index]!.length) continue;
            const delta =
              cost(render(index, count + 1, aliased)) - cost(render(index, count, aliased));
            if (delta <= remaining) {
              counts[index] = count + 1;
              remaining -= delta;
              changed = true;
            }
          }
        }
      }
    }
    const used = counts.map((count, index) =>
      count < 0 ? 0 : cost(render(index, count, aliased)),
    );
    return {
      overhead,
      counts,
      used,
      full,
      omitted: counts.filter((count) => count < 0).length,
      removed: counts.reduce(
        (sum, count, index) => sum + descriptions[index]!.length - Math.max(0, count),
        0,
      ),
    };
  };
  let selected = allocate(false);
  if (roots.length) {
    const aliased = allocate(true);
    if (
      aliased.overhead < limit &&
      (aliased.omitted < selected.omitted ||
        (aliased.omitted === selected.omitted &&
          (aliased.removed < selected.removed ||
            (aliased.removed === selected.removed &&
              aliased.used.reduce((a, b) => a + b, aliased.overhead) <
                selected.used.reduce((a, b) => a + b, selected.overhead)))))
    )
      selected = aliased;
  }
  const collections = new Map<string, typeof Contribution.Type>();
  skills.forEach((skill, index) => {
    if (skill.collectionId === undefined) return;
    const current = collections.get(skill.collectionId) ?? {
      collectionId: skill.collectionId,
      skills: 0,
      used: 0,
      requested: 0,
      shortened: 0,
      omitted: 0,
    };
    collections.set(skill.collectionId, {
      ...current,
      skills: current.skills + 1,
      used: current.used + selected.used[index]!,
      requested: current.requested + selected.full[index]!,
      shortened:
        current.shortened +
        (selected.counts[index]! >= 0 && selected.counts[index]! < descriptions[index]!.length
          ? 1
          : 0),
      omitted: current.omitted + (selected.counts[index]! < 0 ? 1 : 0),
    });
  });
  return {
    skills: skills.map((skill, index) => ({
      name: skill.name,
      path: skill.path,
      requested: selected.full[index]!,
    })),
    budget: {
      status: "estimated",
      cwd: input.cwd,
      model: input.model,
      contextWindow: input.contextWindow,
      unit,
      limit,
      used: selected.used.reduce((a, b) => a + b, selected.overhead),
      requested: selected.full.reduce((a, b) => a + b, selected.overhead),
      sharedOverhead: selected.overhead,
      otherSkills: skills.filter((skill) => skill.collectionId === undefined).length,
      shortened: selected.counts.filter(
        (count, index) => count >= 0 && count < descriptions[index]!.length,
      ).length,
      omitted: selected.omitted,
      collections: [...collections.values()],
    },
  };
}

export function estimateCodexListingBudget(
  input: CodexListingEstimateInput,
): Extract<CodexListingBudget, { status: "estimated" }> {
  return estimateCodexListing(input).budget;
}
