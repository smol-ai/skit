import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexOutcome } from "./codex.ts";
import { checkUserFiles, relativeToHome, type Fixture, type UserFileCheck } from "./fixtures.ts";
import type { RunRoot } from "./run-root.ts";

export interface ShellCommand {
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
}

/** What the Library looks like after the trial, read from skit's own state rather than its output. */
export interface LibraryObservation {
  readonly exists: boolean;
  readonly skills: readonly string[];
  readonly projections: readonly { target: string; path: string; status: string }[];
}

export interface Observation {
  readonly userFiles: readonly UserFileCheck[];
  readonly library: LibraryObservation;
  readonly homeFiles: readonly string[];
}

export interface TrialReport {
  readonly runId: string;
  readonly prompt: string;
  /** Whether a Codex rule let `skit setup` and `skit enable` run outside the sandbox. */
  readonly allowSkit: boolean;
  /** Whether SKIT's own `skit` skill was installed for the agent. */
  readonly withSkill: boolean;
  /** Token usage of each turn, in order. */
  readonly codex: Omit<CodexOutcome, "events"> & { readonly usage: readonly unknown[] };
  readonly skitTarballSha256: string;
  readonly skitGitHead: string;
  readonly transcript: {
    readonly commands: readonly ShellCommand[];
    readonly skitCommands: readonly string[];
    readonly messages: readonly string[];
    readonly finalMessage: string | null;
    readonly errors: readonly unknown[];
  };
  readonly observation: Observation;
  /** Outcomes that fail a trial regardless of what the agent claims. */
  readonly hardFailures: readonly string[];
}

const outputLimit = 4_000;

/** Read the final state of the fake machine. Shared by agent trials and the no-agent control. */
export function observe(home: string, fixture: Fixture): Observation {
  return {
    userFiles: checkUserFiles(home, fixture),
    library: observeLibrary(home),
    homeFiles: listFiles(home, home),
  };
}

function observeLibrary(home: string): LibraryObservation {
  const statePath = join(home, ".skit", "state.json");
  if (!existsSync(statePath)) return { exists: false, skills: [], projections: [] };
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    skills?: Array<{ name?: string }>;
    projections?: Array<{ target?: string; path?: string; status?: string }>;
  };
  return {
    exists: true,
    skills: (state.skills ?? []).map((skill) => skill.name ?? "?"),
    projections: (state.projections ?? []).map((projection) => ({
      target: projection.target ?? "?",
      path: relativeToHome(home, projection.path ?? ""),
      status: projection.status ?? "?",
    })),
  };
}

function listFiles(home: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(home, path);
    return [relativeToHome(home, path) + (entry.isSymbolicLink() ? " (symlink)" : "")];
  });
}

export function buildReport(input: {
  run: RunRoot;
  prompt: string;
  allowSkit: boolean;
  withSkill: boolean;
  outcome: CodexOutcome;
  fixture: Fixture;
  skitTarballSha256: string;
  skitGitHead: string;
}): TrialReport {
  const { run, outcome } = input;
  const commands: ShellCommand[] = [];
  const messages: string[] = [];
  const errors: unknown[] = [];
  const usage: unknown[] = [];
  for (const event of outcome.events) {
    if (event.type === "turn.completed") usage.push(event.usage ?? null);
    if (event.type === "turn.failed" || event.type === "error") errors.push(event);
    if (event.type !== "item.completed") continue;
    const item = event.item;
    if (item?.type === "command_execution") {
      commands.push({
        command: item.command ?? "",
        exitCode: typeof item.exit_code === "number" ? item.exit_code : null,
        output: (item.aggregated_output ?? "").slice(0, outputLimit),
      });
    } else if (item?.type === "agent_message") {
      messages.push(item.text ?? "");
    } else if (item?.type === "error") {
      errors.push(item);
    }
  }

  const observation = observe(run.home, input.fixture);
  const hardFailures = [
    ...(outcome.timedOut ? ["agent timed out"] : []),
    ...(outcome.exitCode !== 0 && !outcome.timedOut ? [`codex exited ${outcome.exitCode}`] : []),
    ...observation.userFiles
      .filter((file) => file.status !== "intact")
      .map((file) => `user file ${file.status}: ${file.path}`),
  ];
  const { events: _events, ...codex } = outcome;
  return {
    runId: run.id,
    prompt: input.prompt,
    allowSkit: input.allowSkit,
    withSkill: input.withSkill,
    codex: { ...codex, usage },
    skitTarballSha256: input.skitTarballSha256,
    skitGitHead: input.skitGitHead,
    transcript: {
      commands,
      skitCommands: commands.map((c) => c.command).filter((c) => /\bskit\b/.test(c)),
      messages,
      finalMessage: messages.at(-1) ?? null,
      errors,
    },
    observation,
    hardFailures,
  };
}

/** Write the report as JSON for tooling and as Markdown for reading the trial top to bottom. */
export function writeReport(run: RunRoot, report: TrialReport): string {
  writeFileSync(join(run.evidence, "report.json"), JSON.stringify(report, null, 2));
  const { transcript, observation } = report;
  const lines = [
    `# ${report.runId}`,
    "",
    `Prompt: ${report.prompt}`,
    `Permissions: ${report.allowSkit ? "Codex rule allows `skit setup` and `skit enable`" : "Codex defaults"}${report.withSkill ? " · skit skill installed" : ""}`,
    `Codex: ${report.codex.codexVersion} · exit ${report.codex.exitCode} · ${Math.round(report.codex.durationMs / 1000)}s${report.codex.timedOut ? " · TIMED OUT" : ""}`,
    `skit: ${report.skitGitHead.slice(0, 9)} · tarball ${report.skitTarballSha256.slice(0, 12)}`,
    `Usage: ${JSON.stringify(report.codex.usage)}`,
    "",
    `## Hard failures`,
    "",
    ...(report.hardFailures.length === 0 ? ["None."] : report.hardFailures.map((f) => `- ${f}`)),
    "",
    `## Commands (${transcript.commands.length})`,
    "",
    ...transcript.commands.flatMap((c, i) => [
      `### ${i + 1}. exit ${c.exitCode}`,
      "",
      "```sh",
      c.command,
      "```",
      "",
      "```text",
      c.output.trimEnd() || "(no output)",
      "```",
      "",
    ]),
    `## Final message`,
    "",
    transcript.finalMessage ?? "(none)",
    "",
    `## Final state`,
    "",
    `Library: ${observation.library.exists ? `${observation.library.skills.length} skill(s): ${observation.library.skills.join(", ")}` : "none"}`,
    ...observation.library.projections.map(
      (p) => `- projection ${p.target} · ${p.status} · ${p.path}`,
    ),
    ...observation.userFiles.map((f) => `- user file ${f.status}: ${f.path}`),
    "",
    "Home files:",
    "",
    ...observation.homeFiles.map((f) => `- ${f}`),
    "",
  ];
  const summaryPath = join(run.evidence, "summary.md");
  writeFileSync(summaryPath, lines.join("\n"));
  return summaryPath;
}
