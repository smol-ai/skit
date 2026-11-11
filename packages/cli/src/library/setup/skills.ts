import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HarnessName } from "@smolai/skit-core/harnesses";
import type { Choice } from "../../terminal/prompter.js";
import { setupLeftAloneReason } from "./reasons.js";
import { harnessOrigin } from "../presentation/harness-origin.js";
import {
  type SetupOnboardingCandidate,
  type SetupSkillInstance,
  recommendedSetupSelection,
  setupReviewCopies,
  type SetupRecommendation,
  type SetupReviewCopy,
} from "@smolai/skit-core/library/setup";

const agentNames: Record<HarnessName, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  devin: "Devin",
};
const usage = (instance: SetupSkillInstance) =>
  instance.harnesses
    .map((agent) => agentNames[agent])
    .sort()
    .join(", ");

const sourceGroup = (instance: SetupSkillInstance, home: string): string => {
  if (instance.owner.kind === "pnpm")
    return `pnpm | ${instance.owner.package}@${instance.owner.version}`;
  if (instance.git.repository) return `Repository | ${instance.git.repository}`;
  const owner = instance.owner;
  if (owner.kind === "harness") return `Plugins | ${harnessOrigin(owner)}`;
  if (owner.kind === "skills-sh") return `Known source | ${owner.source}`;
  if (owner.kind === "skit" && owner.membership.kind === "in-library" && owner.membership.source)
    return `Known source | ${owner.membership.source}`;
  if (owner.kind === "authored") return `Known source | ${owner.skitLocator}`;
  const sources = [...new Set(instance.locks.map((lock) => lock.entry.source))];
  if (sources.length === 1) return `Known source | ${sources[0]}`;
  const parent = dirname(instance.path);
  if (parent === join(home, ".claude", "skills")) return "Claude local skills | ~/.claude/skills";
  if (parent === join(home, ".codex", "skills")) return "Codex local skills | ~/.codex/skills";
  return `Local source | ${parent}`;
};

const groupOrder = (group: string) =>
  [
    "Copies",
    "pnpm",
    "Repository",
    "Local source",
    "Claude local skills",
    "Codex local skills",
    "Known source",
    "Plugins",
  ].findIndex((prefix) => group.startsWith(prefix));

const candidateStatus = (instance: SetupSkillInstance, candidate?: SetupOnboardingCandidate) => {
  if (instance.owner.kind === "pnpm") return "Managed by pnpm | left in place";
  if (instance.owner.kind === "skit")
    return instance.owner.membership.kind === "in-library"
      ? "Already managed in Library"
      : "Managed copy missing from Library | inspect before changing";
  if (instance.owner.kind === "authored") return "Authored SKIT source | kept in place";
  if (candidate?.action === "blocked" && candidate.reason !== "divergent-copies")
    return `Blocked | ${setupLeftAloneReason(candidate.reason)} | preview to inspect`;
  if (candidate?.action === "bind-existing-entry") return "Exact Library match | reconnect";
  if (candidate?.action === "import-observed-collection") return "Add installed copy to Library";
  if (candidate?.action === "repository-owned")
    return "Add to Library; repository files stay in place";
  return candidate ? undefined : "Left in place | no setup action";
};

/** Show discovered copies that still need attention, including blocked content. */
export const setupReviewSkillChoices = (
  copies: readonly (SetupReviewCopy & { readonly removeValue?: string })[],
  recommended: SetupRecommendation,
  home: string,
) => {
  const rows = copies
    .map(({ instance, candidate, value, selectable, groupKey, siblings, removeValue }) => {
      const identical = siblings.filter(
        (item) =>
          instance.contentIdentity.status === "hashed" &&
          item.contentIdentity.status === "hashed" &&
          instance.contentIdentity.currentHash === item.contentIdentity.currentHash,
      );
      const differing = siblings.filter((item) => !identical.includes(item));
      const status = candidateStatus(instance, candidate);
      const disabled = !selectable;
      const copyContext = differing.length
        ? "Content differs | Space selects this copy; other copies stay in place"
        : identical.length
          ? `Duplicate content | ${identical.length} independent cop${identical.length === 1 ? "y" : "ies"}`
          : undefined;
      const sources = [
        ...new Set([
          ...(instance.owner.kind === "skills-sh" ? [instance.owner.source] : []),
          ...(candidate?.action === "import-observed-collection" ? [candidate.source] : []),
          ...instance.locks.map((lock) => lock.entry.source),
        ]),
      ];
      const metadata = [
        `Git: ${instance.git.status === "committed" ? "committed, clean" : instance.git.status.replaceAll("-", " ")}`,
        ...sources.map((source) => `skills.sh lock: ${source}`),
        instance.harnesses.length ? `Discoverable by ${usage(instance)}` : "No agent installation",
        copyContext,
        status,
      ]
        .filter(Boolean)
        .join("\n");
      const links = instance.aliases
        .filter((path) => path !== instance.path)
        .map((path) => `Link: ${path} → ${instance.path}`);
      const details = [instance.path, metadata, ...links].join("\n");
      const choice: Choice<string> = {
        value,
        ...(removeValue === undefined ? {} : { removeValue }),
        label: instance.name,
        hint:
          [
            instance.path,
            ...(instance.git.status !== "outside-git" ? [instance.git.status] : []),
            ...sources,
            ...(disabled ? ["inspect"] : []),
          ].join(" | ") || undefined,
        searchText: details,
        group: differing.length
          ? `Copies | ${instance.name} | ${instance.git.repository ? instance.git.repository : "global"} | choose one`
          : sourceGroup(instance, home),
        disabled,
        // Guided setup starts from the same selection `skit setup --apply` takes.
        selected: recommended.copies.some(
          (copy) => copy.name === instance.name && copy.sourcePath === instance.path,
        ),
        ...(siblings.length ? { exclusiveGroup: groupKey } : {}),
        ...(differing.length ? { selectExplicitly: true } : {}),
      };
      return { instance, candidate, choice, details, groupKey };
    })
    .sort(
      (left, right) =>
        groupOrder(left.choice.group!) - groupOrder(right.choice.group!) ||
        left.choice.group!.localeCompare(right.choice.group!) ||
        left.instance.name.localeCompare(right.instance.name) ||
        left.instance.path.localeCompare(right.instance.path),
    );
  return rows;
};

/** Standalone rendering adapter for an observed setup report. */
export const setupDiscoveredSkillChoices = (
  instances: readonly SetupSkillInstance[],
  candidates: readonly SetupOnboardingCandidate[],
  home = homedir(),
) =>
  setupReviewSkillChoices(
    setupReviewCopies(instances, candidates),
    recommendedSetupSelection(instances, candidates, home),
    home,
  );
