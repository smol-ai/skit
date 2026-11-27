import type { Atlas, CopyIssue, ErrorDefinition, Step } from "../../src/atlas/data.ts";

/** What the Atlas's pages read from the index: groupings, journeys and coverage counts. */

/** The CLI's command group, or undefined for a top-level command. */
export const groupOf = (command: string) => {
  const [group, ...rest] = command.split(" ");
  return rest.length > 0 ? group : undefined;
};

/** Top-level commands first, then each group in the order the CLI lists it. */
export function commandGroups(atlas: Atlas): ReadonlyArray<{
  readonly group: string | undefined;
  readonly commands: readonly Atlas["commands"][number][];
}> {
  const groups = [
    undefined,
    ...new Set(atlas.commands.flatMap(({ command }) => groupOf(command) ?? [])),
  ];
  return groups.map((group) => ({
    group,
    commands: atlas.commands.filter(({ command }) => groupOf(command) === group),
  }));
}

export const flowsRunning = (atlas: Atlas, command: string) =>
  atlas.flows.filter((flow) => flow.commands.includes(command));

/** Commands whose output stories include the story. */
export const commandsShowing = (atlas: Atlas, story: string) =>
  atlas.commands.filter((command) => command.stories.includes(story));

/** Choices the script did not take: each is a branch no journey has recorded yet. */
export const unwalked = (answer: NonNullable<Step["answer"]>) =>
  answer.offered.filter((label) => !answer.chosen.includes(label));

/** One step of a journey and the flow whose recording draws it. */
export interface PathStep {
  readonly owner: string;
  readonly step: Step;
}

/** Every step a flow shows, starting with those it shares with the flows it forks from. */
export function flowPath(atlas: Atlas, name: string): readonly PathStep[] {
  const flow = atlas.flows.find((candidate) => candidate.name === name);
  if (flow === undefined) return [];
  const shared = flow.fork ? flowPath(atlas, flow.fork.parent).slice(0, flow.fork.at) : [];
  return [...shared, ...flow.steps.map((step) => ({ owner: flow.name, step }))];
}

/**
 * The other ways a journey goes on after `index`: one entry per flow that draws this same step
 * but a different next step, named by the flow that draws that next step.
 */
export function branchesAfter(
  atlas: Atlas,
  name: string,
  index: number,
): ReadonlyArray<{ readonly flow: string; readonly next: Step }> {
  const path = flowPath(atlas, name);
  const here = path[index];
  if (here === undefined) return [];
  const branches = new Map<string, Step>();
  for (const other of atlas.flows) {
    const otherPath = flowPath(atlas, other.name);
    const next = otherPath[index + 1];
    if (otherPath[index]?.owner !== here.owner || next === undefined) continue;
    if (next.owner !== path[index + 1]?.owner) branches.set(next.owner, next.step);
  }
  return [...branches].map(([flow, next]) => ({ flow, next }));
}

/** Where a copy issue appears: the flow step that first shows it, or an output story. */
export type IssuePlace =
  | {
      readonly kind: "step";
      readonly flow: string;
      readonly step: number;
      readonly label: string;
    }
  | { readonly kind: "story"; readonly key: string };

/**
 * Every copy issue once, with each place that shows it: flow steps, then stories. One text can be
 * flagged in many places, such as a placeholder hash in several stories; listing it once keeps
 * the list a list of things to fix.
 */
export function copyIssues(
  atlas: Atlas,
): ReadonlyArray<{ readonly issue: CopyIssue; readonly places: readonly IssuePlace[] }> {
  const found: ReadonlyArray<{ readonly issue: CopyIssue; readonly place: IssuePlace }> = [
    ...atlas.flows.flatMap((flow) =>
      flow.steps.flatMap((step, index) =>
        step.issues.map((issue) => ({
          issue,
          place: {
            kind: "step" as const,
            flow: flow.name,
            step: (flow.fork?.at ?? 0) + index + 1,
            label: step.label,
          },
        })),
      ),
    ),
    ...atlas.stories.flatMap((story) =>
      story.issues.map((issue) => ({ issue, place: { kind: "story" as const, key: story.key } })),
    ),
  ];
  return [...new Set(found.map(({ issue }) => issue.text))].flatMap((text) => {
    const same = found.filter(({ issue }) => issue.text === text);
    return same[0] === undefined
      ? []
      : [{ issue: same[0].issue, places: same.map(({ place }) => place) }];
  });
}

/** The coverage totals the overview leads with. */
export function totals(atlas: Atlas) {
  const reported = atlas.contracts.flatMap((contract) => contract.states);
  const answers = atlas.flows.flatMap((flow) =>
    flow.steps.flatMap((step) => (step.answer?.offered.length ? [step.answer] : [])),
  );
  const offered = answers.reduce((sum, answer) => sum + answer.offered.length, 0);
  return {
    commands: atlas.commands.length,
    commandsInFlow: atlas.commands.filter(({ command }) => flowsRunning(atlas, command).length > 0)
      .length,
    states: reported.length,
    statesWithStory: reported.filter((state) => state.stories.length > 0).length,
    contracts: atlas.contracts.length,
    contractsWithStates: atlas.contracts.filter((contract) => contract.states.length > 0).length,
    offered,
    walked: offered - answers.reduce((sum, answer) => sum + unwalked(answer).length, 0),
    issues: copyIssues(atlas).length,
  };
}

/** Why a copy issue is flagged, in the words a tooltip shows. */
export const flagged = (issue: CopyIssue) => {
  switch (issue.kind) {
    case "ID":
      return "Type ID: an identifier where a name belongs";
    case "hash":
      return "Hash: a raw hash where a person reads";
    case "code":
      return "Code: an internal constant where words belong";
    case "term":
      return `Avoided verb: ${issue.verb ?? issue.text}, CONTEXT.md`;
  }
};

export const plural = (count: number, word: string, many = `${word}s`) =>
  `${count} ${count === 1 ? word : many}`;

/** Select the recorded plain output where available; flow recordings are styled at render time. */
export function framePath(atlas: Atlas, path: string, color: boolean): string {
  if (color) return path;
  return (
    [...atlas.stories, ...atlas.frames, ...atlas.blocks].find((item) => item.color === path)
      ?.plain ?? path
  );
}

/** Actual recorded presenter output for an error; source strings are never message examples. */
export const errorExamples = (atlas: Atlas, error: ErrorDefinition) =>
  atlas.stories.filter((story) => story.errorTags.includes(error.tag));
