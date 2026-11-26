import { collectGuarantees } from "./guarantee-catalog.ts";
import { readTestReports } from "./test-reports.ts";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import {
  type JourneyRecording,
  type ReplayFrame,
  type TerminalEnvironment,
  defaultTerminalEnvironment,
  blockExamples,
  commandCoverage,
  frameExamples,
  journeyStories,
  outputStories,
  renderOutputFrame,
  renderReplayFrame,
  renderStatusLine,
  STATUS_FRAME_MS,
  storyCoverage,
} from "@smolai/skit/storybook";
import { layoutTerminal } from "../image/export.ts";
import { stripVTControlCharacters } from "node:util";
import { branchFlows } from "./branches.ts";
import { copyIssues, markIssues } from "./copy-issues.ts";
import { Atlas, type CopyIssue, Frame, type Row, type Step } from "./data.ts";

import { domainVocabulary } from "./vocabulary.ts";
import { persistedStores, storeOwnerFiles } from "./persistence.ts";
import { atlasProgram, inspectErrors } from "./errors.ts";
import { commandErrors } from "./command-errors.ts";
import { generateSystemMap } from "./system-map.ts";

const columns = 88;
const environment: TerminalEnvironment = {
  ...defaultTerminalEnvironment,
  color: true,
  format: "human",
  width: columns,
};
// The Atlas app's static data: Vite serves this folder in development and copies it into the build.
const output = fileURLToPath(new URL("../../atlas-data/", import.meta.url));
await rm(output, { recursive: true, force: true });

/**
 * Lays terminal text out as rows of styled runs, marking where each copy issue falls. Spaces a
 * row ends with are dropped unless they show something.
 */
const rows = async (
  ansi: string,
  issues: readonly CopyIssue[],
  width = columns,
): Promise<readonly Row[]> =>
  (await layoutTerminal(markIssues(ansi, issues), width)).map((laid) => {
    const runs = laid.map((run) => ({
      text: run.cells.map(({ char }) => char).join(""),
      ...(run.foreground === undefined ? {} : { foreground: run.foreground }),
      ...(run.background === undefined ? {} : { background: run.background }),
      ...(run.inverse ? { inverse: true } : {}),
      ...(run.bold ? { bold: true } : {}),
      ...(run.dim ? { dim: true } : {}),
      ...(run.italic ? { italic: true } : {}),
      ...(run.underline ? { underline: true } : {}),
    }));
    const text = runs.map((run) => run.text).join("");
    // Issues were overlined before layout; each overlined stretch is one issue on this row.
    const offsets = runs.map((_, index) =>
      runs.slice(0, index).reduce((sum, run) => sum + run.text.length, 0),
    );
    const spans = laid.reduce<ReadonlyArray<{ start: number; end: number }>>(
      (found, run, index) => {
        if (!run.overline) return found;
        const start = offsets[index]!;
        const end = start + runs[index]!.text.length;
        const last = found.at(-1);
        return last?.end === start
          ? [...found.slice(0, -1), { start: last.start, end }]
          : [...found, { start, end }];
      },
      [],
    );
    const marks = spans.flatMap(({ start, end }) => {
      const part = text.slice(start, end);
      const issue =
        issues.find((candidate) => candidate.text === part) ??
        issues.find((candidate) => candidate.text.includes(part));
      return issue === undefined ? [] : [{ start, end, issue }];
    });
    const plain = (run: (typeof runs)[number]) =>
      run.background === undefined && !run.inverse && !run.underline;
    const kept = runs.slice(
      0,
      runs.findLastIndex((run) => !plain(run) || run.text.trim() !== "") + 1,
    );
    const last = kept.at(-1);
    return {
      runs:
        last !== undefined && plain(last)
          ? [...kept.slice(0, -1), { ...last, text: last.text.trimEnd() }]
          : kept,
      ...(marks.length > 0 ? { issues: marks } : {}),
    };
  });

// The status line's spinner, as the CLI draws it frame by frame.
const glyph = (frame: number) => renderStatusLine("", frame).trim();
const spinner = [glyph(0)];
for (let frame = 1; glyph(frame) !== glyph(0); frame++) spinner.push(glyph(frame));

/** Writes a frame file under the data folder and returns its path there. */
const write = async (path: string, frame: Frame) => {
  const file = join(output, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(Schema.encodeSync(Frame)(frame)));
  return path;
};

const plainEnvironment = { ...environment, color: false };
const stories = [];
for (const [index, story] of outputStories.entries()) {
  const color = renderOutputFrame(index, environment);
  const plain = renderOutputFrame(index, plainEnvironment);
  if (!color || !plain) continue;
  // A story is one whole screen: every issue on it is its own.
  const issues = copyIssues(stripVTControlCharacters(color.stdout + color.stderr));
  stories.push({
    key: story.key,
    errorTags: story.errorTags ?? [],
    text: stripVTControlCharacters(plain.stdout + plain.stderr),
    ...(story.scenario ? { scenario: story.scenario } : {}),
    ...(color.exitCode ? { exitCode: color.exitCode } : {}),
    issues,
    color: await write(`frames/stories/${story.key}.json`, {
      rows: await rows(color.stdout + color.stderr, issues),
    }),
    plain: await write(`frames/stories/${story.key}.plain.json`, {
      rows: await rows(plain.stdout + plain.stderr, issues),
    }),
  });
}

const coverage = storyCoverage();
/** The contract's other states, each with the story that shows it when one exists. */
const otherOutcomes = (outcome: { contract: string; state?: string }) =>
  (coverage.find((contract) => contract.contract === outcome.contract)?.states ?? [])
    .filter(({ state }) => state !== outcome.state)
    .map(({ state, stories }) => ({ state, ...(stories[0] ? { story: stories[0] } : {}) }));

// Each journey's command lines name commands; the longest command a line starts with is the one it runs.
const commandsCovered = await Effect.runPromise(commandCoverage);
const ran = (line: string) =>
  commandsCovered
    .map(({ command }) => command)
    .filter((command) => `${line} `.startsWith(`skit ${command} `))
    .sort((left, right) => right.length - left.length)[0];

const recordings: Array<{
  description: string;
  evidence?: string;
  recording: JourneyRecording;
  frames: readonly ReplayFrame[];
}> = [];
for (const journey of journeyStories) {
  const recording = await Effect.runPromise(journey.record);
  if (recording._tag === "Journey" && recording.finalState.startsWith("failed:"))
    throw new Error(`Atlas journey failed: ${journey.name}: ${recording.finalState}`);
  recordings.push({
    description: journey.description,
    ...(journey.evidence ? { evidence: journey.evidence } : {}),
    recording,
    frames: recording.frames(environment),
  });
}
const tree = branchFlows(
  recordings,
  ({ frames }) => frames.map((frame) => `${frame.label}\u0000${renderReplayFrame(frame, 0)}`),
  ({ recording }) => (recording._tag === "Scenario" ? recording.world : undefined),
);
const flows = [];
for (const { flow, fork } of tree) {
  const at = fork?.at ?? 0;
  const name = flow.recording.name;
  // Each screen keeps what earlier steps printed; dim it so this step's own lines stand out.
  const seen = new Set<string>();
  const screens = flow.frames.map((frame, index) => {
    const before = flow.frames[index - 1]?.output ?? "";
    const earlier = frame.output.startsWith(before) ? before : "";
    const { status, ...shown } = frame;
    // The status line is kept apart so the app can animate its spinner.
    const fresh = renderReplayFrame({ ...shown, output: frame.output.slice(earlier.length) }, 0);
    const issues = copyIssues(stripVTControlCharacters(`${fresh}${status ?? ""}`));
    const firstSeen = issues.filter((issue) => !seen.has(issue.text));
    for (const issue of issues) seen.add(issue.text);
    return {
      ansi: (earlier && `\u001b[2m${stripVTControlCharacters(earlier)}\u001b[22m`) + fresh,
      status,
      issues,
      firstSeen,
    };
  });
  const steps: Step[] = [];
  for (const [index, frame] of flow.frames.entries()) {
    if (index < at) continue;
    const screen = screens[index]!;
    const [statusRow] = screen.status === undefined ? [] : await rows(screen.status, screen.issues);
    steps.push({
      ...(frame.event === undefined ? {} : { event: frame.event }),
      ...(frame.command === undefined ? {} : { command: frame.command }),
      kind: frame.answer
        ? "answer"
        : frame.outcome
          ? "result"
          : frame.prompt
            ? "prompt"
            : frame.status && frame.label === frame.status
              ? "progress"
              : "step",
      ...(frame.status ? { progress: frame.status.split(" | ")[0]!.trim() } : {}),
      label: frame.label,
      frame: await write(`frames/flows/${name}/${index + 1}.json`, {
        rows: await rows(screen.ansi, screen.issues),
        ...(statusRow === undefined
          ? {}
          : { status: { spinner, interval: STATUS_FRAME_MS, row: statusRow } }),
      }),
      issues: screen.firstSeen,
      ...(frame.outcome
        ? { outcome: { ...frame.outcome, others: otherOutcomes(frame.outcome) } }
        : {}),
      ...(frame.answer ? { answer: frame.answer } : {}),
    });
  }
  flows.push({
    name,
    description: flow.description,
    ...(flow.evidence ? { evidence: flow.evidence } : {}),
    ...(flow.recording._tag === "Scenario"
      ? {
          _tag: flow.recording._tag,
          world: flow.recording.world,
          worldLabels: flow.recording.worldLabels,
          terminalDevice: flow.recording.terminalDevice,
        }
      : {
          _tag: flow.recording._tag,
          initialState: flow.recording.initialState,
          finalState: flow.recording.finalState,
        }),
    commands: [
      ...new Set(
        flow.recording.commands.flatMap((line) => {
          const command = ran(line);
          return command === undefined ? [] : [command];
        }),
      ),
    ],
    ...(fork === undefined
      ? {}
      : { fork: { parent: tree[fork.parent]!.flow.recording.name, at: fork.at } }),
    steps,
  });
}

/** Each example with and without colour, under `folder`. */
const writeExamples = async (
  folder: string,
  color: ReadonlyArray<{ name: string; output: string }>,
  plain: ReadonlyArray<{ output: string }>,
  width: number,
) => {
  const examples = [];
  for (const [index, example] of color.entries())
    examples.push({
      name: example.name,
      width,
      color: await write(`frames/${folder}/${index + 1}.json`, {
        rows: await rows(example.output, [], width),
      }),
      plain: await write(`frames/${folder}/${index + 1}.plain.json`, {
        rows: await rows(plain[index]!.output, [], width),
      }),
    });
  return examples;
};

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const program = await atlasProgram(root);
const errors = inspectErrors(program, root, storeOwnerFiles);
const errorsByCommand = commandErrors(program, root);
const commands = commandsCovered.map((command) => {
  const keys = errorsByCommand.get(command.command);
  if (!keys) throw new Error(`Command errors missing: ${command.command}`);
  const dependencyErrors = keys.filter((key) => key.includes("node_modules/"));
  const localErrors = keys.filter((key) => !dependencyErrors.includes(key));
  for (const key of localErrors) {
    if (!errors.some((error) => `${error.file}/${error.name}` === key))
      throw new Error(`Command error absent from catalog: ${command.command}: ${key}`);
  }
  return {
    ...command,
    errors: localErrors,
    dependencyErrors: dependencyErrors.map((key) => key.split("node_modules/").at(-1)!),
  };
});
for (const command of commands) {
  for (const scenario of command.scenarios ?? []) {
    if (scenario.flow && !flows.some((flow) => flow.name === scenario.flow))
      throw new Error(`Scenario flow missing: ${command.command}/${scenario.name}`);
  }
}
const persistence = await persistedStores(root, program);
const systemMap = await Effect.runPromise(generateSystemMap(root, output, persistence));
console.log(
  `Service map: ${systemMap.services.length} declarations, ${(systemMap.elapsedMs / 1000).toFixed(2)}s extraction.`,
);
const atlas = {
  systemMap,
  guaranteeFiles: await collectGuarantees(root),
  testReports: await Effect.runPromise(readTestReports(root)),
  ...(await domainVocabulary(root)),
  persistence,
  errors,
  commands,
  contracts: coverage.map((contract) => ({
    ...contract,
    ...(contract.variants
      ? {
          variants: contract.variants.map((variant) => ({
            ...variant,
            recordings: recordings.flatMap(({ recording, frames }) =>
              frames.flatMap((frame, index) =>
                frame.outcome?.contract === contract.contract &&
                frame.outcome.state === variant.state &&
                frame.outcome.variants?.some(
                  (found) => found.field === variant.field && found.value === variant.value,
                )
                  ? [{ flow: recording.name, step: index + 1 }]
                  : [],
              ),
            ),
          })),
        }
      : {}),
  })),
  stories,
  flows,
  frames: await writeExamples(
    "frames",
    frameExamples(environment),
    frameExamples(plainEnvironment),
    columns,
  ),
  blocks: (
    await Promise.all(
      [40, 100].map((width) =>
        writeExamples(
          `blocks/${width}`,
          blockExamples({ color: true, width }),
          blockExamples({ color: false, width }),
          width,
        ),
      ),
    )
  )
    .flat()
    .sort((left, right) => left.name.localeCompare(right.name) || left.width - right.width),
};
await writeFile(join(output, "atlas.json"), JSON.stringify(Schema.encodeSync(Atlas)(atlas)));
console.log(
  `Wrote ${relative(process.env.INIT_CWD ?? process.cwd(), output)}: ${flows.length} flows, ${stories.length} stories.`,
);
