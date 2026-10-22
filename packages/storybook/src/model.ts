import {
  OutputStory,
  journeyStories,
  outputStories,
  outputStoryKey,
  renderFailureFrame,
  renderResultFrame,
  type TerminalEnvironment,
} from "../../cli/src/front-end";

export type CatalogItem =
  | { readonly kind: "output"; readonly key: string; readonly index: number }
  | { readonly kind: "journey"; readonly key: string; readonly index: number };

const byKey = (left: CatalogItem, right: CatalogItem): number => left.key.localeCompare(right.key);

export const catalog: ReadonlyArray<CatalogItem> = [
  ...outputStories
    .map((story, index) => ({
      kind: "output" as const,
      key: outputStoryKey(story),
      index,
    }))
    .sort(byKey),
  ...journeyStories
    .map((story, index) => ({
      kind: "journey" as const,
      key: `journey/${story.name}`,
      index,
    }))
    .sort(byKey),
];

export const filterCatalog = (query: string): ReadonlyArray<CatalogItem> => {
  const needle = query.trim().toLowerCase();
  return needle ? catalog.filter(({ key }) => key.toLowerCase().includes(needle)) : catalog;
};

/** Renders an output story exactly as the CLI front end would. */
export function renderOutputFrame(index: number, environment: TerminalEnvironment) {
  const story = outputStories[index];
  return (
    story &&
    OutputStory.$match(story, {
      Result: ({ result }) => renderResultFrame(result, environment),
      Failure: ({ failure }) => renderFailureFrame(failure, environment.format),
    })
  );
}

export function renderOutput(index: number, environment: TerminalEnvironment): string {
  const frame = renderOutputFrame(index, environment);
  if (!frame) return "Story not found";
  return [
    frame.stdout && frame.stdout.trimEnd(),
    frame.stderr && `STDERR\n${frame.stderr.trimEnd()}`,
    frame.exitCode !== undefined && `EXIT ${frame.exitCode}`,
  ]
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n\n");
}
