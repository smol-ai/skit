import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { HarnessName } from "@smolai/skit-core";
import type { Choice } from "./prompter.js";
import type {
  SetupOnboardingCandidate,
  SetupSkillInstance,
} from "../workflows/library/setup-contract.js";
import { isSetupCandidateFromCodex, setupInstanceGroupKey } from "../workflows/library/setup.js";

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
  if (instance.git.repository) return `Repository · ${compactPath(instance.git.repository, home)}`;
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
    "Copies",
    "Repository",
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
  if (candidate?.action === "import-observed-collection") return "Add installed copy to Library";
  if (candidate?.action === "repository-owned")
    return "Add to Library; project files stay in place";
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
    .filter(
      (instance) =>
        !candidates.some(
          (candidate) =>
            candidate.action === "import-observed-collection" &&
            candidate.paths.includes(instance.path),
        ),
    )
    .map((instance) => {
      const candidate = candidates.find((item) => item.paths.includes(instance.path));
      const groupKey = setupInstanceGroupKey(instance);
      const siblings = instances.filter(
        (item) => setupInstanceGroupKey(item) === groupKey && item.path !== instance.path,
      );
      const sameNameElsewhere = instances.some(
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
        ? "Content differs · Space selects this copy; other copies stay in place"
        : identical.length
          ? `Duplicate content · ${identical.length} independent cop${identical.length === 1 ? "y" : "ies"}`
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
        .map((path) => `Link: ${compactPath(path, home)} → ${compactPath(instance.path, home)}`);
      const details = [compactPath(instance.path, home), metadata, ...links].join("\n");
      const choice: Choice<string> = {
        value: sameNameElsewhere ? `${instance.name}\0${instance.path}` : instance.name,
        label: instance.name,
        hint:
          [
            compactPath(instance.path, home),
            ...(instance.git.status !== "outside-git" ? [instance.git.status] : []),
            ...sources,
            ...(disabled ? ["inspect"] : []),
          ].join(" · ") || undefined,
        searchText: details,
        group: differing.length
          ? `Copies · ${instance.name} · ${instance.git.repository ? compactPath(instance.git.repository, home) : "global"} · choose one`
          : sourceGroup(instance, home),
        disabled,
        selected:
          !disabled &&
          differing.length === 0 &&
          instance.owner.kind === "unknown" &&
          instance.git.repository === undefined &&
          !isSetupCandidateFromCodex([instance.path], home),
        ...(siblings.length ? { exclusiveGroup: groupKey } : {}),
        ...(differing.length ? { selectExplicitly: true } : {}),
      };
      return { instance, candidate, choice, details };
    })
    .sort(
      (left, right) =>
        groupOrder(left.choice.group!) - groupOrder(right.choice.group!) ||
        left.choice.group!.localeCompare(right.choice.group!) ||
        left.instance.name.localeCompare(right.instance.name) ||
        left.instance.path.localeCompare(right.instance.path),
    );
  const selectedGroups = new Set<string>();
  for (const { instance, choice } of rows) {
    const key = setupInstanceGroupKey(instance);
    if (choice.selected && selectedGroups.has(key)) choice.selected = false;
    if (choice.selected) selectedGroups.add(key);
  }
  return rows;
};
