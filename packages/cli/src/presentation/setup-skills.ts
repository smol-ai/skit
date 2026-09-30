import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { HarnessName } from "@smolai/skit-core";
import type { Choice } from "./prompter.js";
import type {
  SetupOnboardingCandidate,
  SetupSkillInstance,
} from "../workflows/library/setup-contract.js";
import { isSetupCandidateFromCodex } from "../workflows/library/setup.js";

const compactPath = (path: string, home: string) =>
  path === home ? "~" : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;

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
  const owner = instance.owner;
  if (owner.kind === "harness") return `Plugins · ${owner.source}`;
  if (owner.kind === "skills-sh") return `Known source · ${owner.source}`;
  if (owner.kind === "skit" && owner.membership.kind === "retained" && owner.membership.source)
    return `Known source · ${owner.membership.source}`;
  if (owner.kind === "authored") return `Known source · ${owner.skitLocator}`;
  const sources = [...new Set(instance.locks.map((lock) => lock.entry.source))];
  if (sources.length === 1) return `Known source · ${sources[0]}`;
  const parent = dirname(instance.path);
  if (parent === join(home, ".claude", "skills")) return "Claude local skills · ~/.claude/skills";
  if (parent === join(home, ".codex", "skills")) return "Codex local skills · ~/.codex/skills";
  return `Local source · ${compactPath(parent, home)}`;
};

const groupOrder = (group: string) =>
  [
    "Local source",
    "Claude local skills",
    "Codex local skills",
    "Known source",
    "Plugins",
  ].findIndex((prefix) => group.startsWith(prefix));

const candidateStatus = (instance: SetupSkillInstance, candidate?: SetupOnboardingCandidate) => {
  if (instance.owner.kind === "skit")
    return instance.owner.membership.kind === "retained"
      ? "Already managed in Library"
      : "Managed copy missing from Library · inspect before changing";
  if (instance.owner.kind === "authored") return "Authored SKIT source · kept in place";
  if (candidate?.action === "blocked" && candidate.reason !== "divergent-copies")
    return `Blocked · ${candidate.reason.replaceAll("-", " ")} · preview to inspect`;
  if (candidate?.action === "bind-existing-entry") return "Exact Library match · reconnect";
  if (candidate?.action === "import-observed-collection") return "Recorded source · add to Library";
  return candidate ? undefined : "Already retained · kept in place";
};

/** Show discovered copies that still need attention, including blocked content. */
export const setupDiscoveredSkillChoices = (
  instances: readonly SetupSkillInstance[],
  candidates: readonly SetupOnboardingCandidate[],
  home = homedir(),
) => {
  const rows = instances
    .filter(
      (instance) => instance.owner.kind !== "skit" || instance.owner.membership.kind !== "retained",
    )
    .map((instance) => {
      const candidate = candidates.find((item) => item.paths.includes(instance.path));
      const siblings = instances.filter(
        (item) => item.name === instance.name && item.path !== instance.path,
      );
      const identical = siblings.filter(
        (item) =>
          instance.contentIdentity.observedHash !== undefined &&
          instance.contentIdentity.observedHash === item.contentIdentity.observedHash,
      );
      const differing = siblings.filter((item) => !identical.includes(item));
      const status = candidateStatus(instance, candidate);
      const disabled =
        !candidate ||
        instance.owner.kind === "skit" ||
        instance.owner.kind === "authored" ||
        (candidate.action === "blocked" && candidate.reason !== "divergent-copies");
      const copyContext = differing.length
        ? `Different copy also exists in ${differing.map((item) => usage(item) || compactPath(dirname(item.path), home)).join("; ")} · choose a copy with Space`
        : identical.length
          ? `Duplicate content · ${identical.length} independent cop${identical.length === 1 ? "y" : "ies"}`
          : undefined;
      const choice: Choice<string> = {
        value: siblings.length ? `${instance.name}\0${instance.path}` : instance.name,
        label: instance.name,
        hint: compactPath(instance.path, home),
        group: sourceGroup(instance, home),
        description: [
          instance.harnesses.length ? `Used by ${usage(instance)}` : "No agent installation",
          instance.aliases.some((path) => path !== instance.path) ? "symlinked" : "local directory",
          copyContext,
          status,
        ]
          .filter(Boolean)
          .join(" · "),
        detail:
          instance.aliases
            .filter((path) => path !== instance.path)
            .map((path) => compactPath(path, home))
            .join(" · ") || undefined,
        disabled,
        selected:
          !disabled &&
          differing.length === 0 &&
          instance.owner.kind !== "harness" &&
          !isSetupCandidateFromCodex([instance.path], home),
        ...(siblings.length ? { exclusiveGroup: instance.name } : {}),
        ...(differing.length ? { selectExplicitly: true } : {}),
      };
      return { instance, candidate, choice };
    })
    .sort(
      (left, right) =>
        groupOrder(left.choice.group!) - groupOrder(right.choice.group!) ||
        left.choice.group!.localeCompare(right.choice.group!) ||
        left.instance.name.localeCompare(right.instance.name) ||
        left.instance.path.localeCompare(right.instance.path),
    );
  const selectedNames = new Set<string>();
  for (const { instance, choice } of rows) {
    if (choice.selected && selectedNames.has(instance.name)) choice.selected = false;
    if (choice.selected) selectedNames.add(instance.name);
  }
  return rows;
};
