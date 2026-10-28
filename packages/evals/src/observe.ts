import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Result, Schema } from "effect";
import {
  LibraryState,
  currentSkillVersion,
  versionBacking,
  collectionVersionPath,
  originalTreeHash,
  scanInventory,
  skitLayer,
} from "@smolai/skit-core";
import type { CodexOutcome, Permissions } from "./codex.ts";
import {
  checkUserFiles,
  checkUserLinks,
  sha256,
  relativeToHome,
  type Fixture,
  type UserFileCheck,
  type UserLinkCheck,
} from "./fixtures.ts";
import type { RunRoot } from "./run-root.ts";

export interface ShellCommand {
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
}

/** What the Library looks like after the trial, read from skit's own state rather than its output. */
export interface LibraryObservation {
  readonly exists: boolean;
  readonly problems: readonly string[];
  readonly skills: readonly string[];
  readonly projections: readonly { target: string; path: string; status: string }[];
}

export interface Observation {
  readonly userFiles: readonly UserFileCheck[];
  readonly userLinks: readonly UserLinkCheck[];
  readonly library: LibraryObservation;
  /** Folders skit scans for repositories, relative to home, from `~/.skit/machine.json`. */
  readonly repositoryRoots: readonly string[];
  /** Every entry directly inside `~/.agents/skills` and `~/.claude/skills`, relative to home. */
  readonly skillFolders: readonly string[];
  /** The browser login skit saved for its next run, if one is waiting for approval. */
  readonly pendingLogin: { readonly userCode: string; readonly verificationUri: string } | null;
  readonly credentialSaved: boolean;
  readonly homeFiles: readonly string[];
}

export interface TrialReport {
  readonly runId: string;
  readonly case: string;
  readonly prompt: string;
  /** What Codex's sandbox allowed beyond its defaults. */
  readonly permissions: Permissions;
  /** Token usage of each turn, in order. */
  readonly codex: Omit<CodexOutcome, "events"> & { readonly usage: readonly unknown[] };
  readonly skitTarballSha256: string;
  readonly skitGitHead: string;
  readonly skitGitDirty: boolean;
  readonly transcript: {
    readonly commands: readonly ShellCommand[];
    readonly skitCommands: readonly string[];
    readonly messages: readonly string[];
    readonly finalMessage: string | null;
    readonly errors: readonly unknown[];
  };
  readonly observation: Observation;
  /** Why the trial failed, from the process and the final state; empty when the task was done. */
  readonly failures: readonly string[];
}

const outputLimit = 4_000;

/** Read the final state of the fake machine. Shared by agent trials and the no-agent control. */
export async function observe(home: string, fixture: Fixture): Promise<Observation> {
  const machine = readJson<{ discoveryRoots?: string[] }>(join(home, ".skit", "machine.json"));
  const pending = readJson<{ userCode?: string; verificationUri?: string }>(
    join(home, ".skit", "login-pending.json"),
  );
  return {
    userFiles: checkUserFiles(home, fixture),
    userLinks: checkUserLinks(home, fixture),
    library: await observeLibrary(home, fixture),
    repositoryRoots: (machine?.discoveryRoots ?? []).map((root) => relativeToHome(home, root)),
    skillFolders: [".agents/skills", ".claude/skills"].flatMap((root) =>
      existsSync(join(home, root))
        ? readdirSync(join(home, root)).map((name) => `${root}/${name}`)
        : [],
    ),
    pendingLogin: pending
      ? { userCode: pending.userCode ?? "", verificationUri: pending.verificationUri ?? "" }
      : null,
    credentialSaved: existsSync(join(home, ".skit", "auth.json")),
    homeFiles: listFiles(home, home),
  };
}

/**
 * What any trial must leave as it found it: the user's files and links, and no skill folder that is
 * neither theirs nor a copy skit records. Judged from the final state alone, so any sequence of
 * commands that leaves the machine right passes.
 */
export function preservationFailures(observation: Observation): string[] {
  const accounted = new Set([
    ...observation.library.projections.map((projection) => projection.path),
    ...observation.userLinks.map((link) => link.path),
    ...observation.userFiles.map((file) => file.path.split("/").slice(0, 3).join("/")),
  ]);
  return [
    ...observation.library.problems,
    ...observation.userFiles
      .filter((file) => file.status !== "intact")
      .map((file) => `user file ${file.status}: ${file.path}`),
    ...observation.userLinks
      .filter((link) => link.status !== "intact")
      .map((link) => `user link ${link.status}: ${link.path}`),
    ...observation.skillFolders
      .filter((folder) => !accounted.has(folder))
      .map((folder) => `skill folder skit does not record: ${folder}`),
  ];
}

function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

async function observeLibrary(home: string, fixture: Fixture): Promise<LibraryObservation> {
  const state = readJson<unknown>(join(home, ".skit", "state.json"));
  if (!state) return { exists: false, skills: [], projections: [], problems: [] };
  const decoded = Schema.decodeUnknownResult(LibraryState)(state);
  if (Result.isFailure(decoded))
    return { exists: true, skills: [], projections: [], problems: ["invalid Library state"] };
  return Effect.runPromise(
    Effect.gen(function* () {
      // Observe a private snapshot: this verifies installed-skill bytes and markers without repairing
      // anything or publishing refreshed statuses to the machine being judged.
      const observed = yield* scanInventory(decoded.success, []);
      const problems: string[] = [];
      for (const skill of observed.skills) {
        const version = currentSkillVersion(observed, skill);
        const backing = version && versionBacking(observed, skill, version);
        if (!version || !backing) {
          problems.push(`no retained backing for ${skill.name}`);
          continue;
        }
        const root = collectionVersionPath(join(home, ".skit", "originals"), backing.copy.digest);
        const path = join(root, backing.member.source_path);
        const hash = yield* originalTreeHash(path).pipe(Effect.option);
        if (hash._tag === "None" || hash.value !== version.source_digest)
          problems.push(`retained content missing or changed: ${skill.name}`);
        const originals = fixture.userFiles.filter((file) =>
          file.path.endsWith(`/${skill.name}/SKILL.md`),
        );
        const document = join(path, "SKILL.md");
        if (
          originals.length &&
          (!existsSync(document) ||
            !originals.some((file) => file.sha256 === sha256(readFileSync(document))))
        )
          problems.push(`retained skill differs from fixture: ${skill.name}`);
      }
      return {
        exists: true,
        skills: observed.skills.map((skill) => skill.name),
        projections: observed.installed_skills.map((projection) => ({
          target: projection.destination,
          path: relativeToHome(home, projection.path),
          status: projection.status,
        })),
        problems,
      };
    }).pipe(Effect.provide(skitLayer)),
  );
}

function listFiles(home: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(home, path);
    return [relativeToHome(home, path) + (entry.isSymbolicLink() ? " (symlink)" : "")];
  });
}

export async function buildReport(input: {
  run: RunRoot;
  caseId: string;
  prompt: string;
  permissions: Permissions;
  outcome: CodexOutcome;
  fixture: Fixture;
  /** The case's own check of whether the task was done. */
  verify: (evidence: { observation: Observation; finalMessage: string | null }) => string[];
  skitTarballSha256: string;
  skitGitHead: string;
  skitGitDirty: boolean;
}): Promise<TrialReport> {
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

  const observation = await observe(run.home, input.fixture);
  const finalMessage = messages.at(-1) ?? null;
  const failures = [
    ...(outcome.timedOut ? ["agent timed out"] : []),
    ...(outcome.exitCode !== 0 && !outcome.timedOut ? [`codex exited ${outcome.exitCode}`] : []),
    ...preservationFailures(observation),
    ...input.verify({ observation, finalMessage }),
  ];
  const { events: _events, ...codex } = outcome;
  return {
    runId: run.id,
    case: input.caseId,
    prompt: input.prompt,
    permissions: input.permissions,
    codex: { ...codex, usage },
    skitTarballSha256: input.skitTarballSha256,
    skitGitHead: input.skitGitHead,
    skitGitDirty: input.skitGitDirty,
    transcript: {
      commands,
      skitCommands: commands.map((c) => c.command).filter((c) => /\bskit\b/.test(c)),
      messages,
      finalMessage,
      errors,
    },
    observation,
    failures,
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
    `Permissions: workspace-write${report.permissions.writable.map((path) => ` · writes ~/${path}`).join("")}${report.permissions.network ? " · network" : ""}`,
    `Codex: ${report.codex.codexVersion} · ${report.codex.model} · exit ${report.codex.exitCode} · ${Math.round(report.codex.durationMs / 1000)}s${report.codex.timedOut ? " · TIMED OUT" : ""}`,
    `skit: ${report.skitGitHead.slice(0, 9)}${report.skitGitDirty ? " + uncommitted changes" : ""} · tarball ${report.skitTarballSha256.slice(0, 12)}`,
    `Usage: ${JSON.stringify(report.codex.usage)}`,
    "",
    `## Failures`,
    "",
    ...(report.failures.length === 0 ? ["None."] : report.failures.map((f) => `- ${f}`)),
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
    ...observation.userLinks.map((l) => `- user link ${l.status}: ${l.path}`),
    `Repository roots: ${observation.repositoryRoots.join(", ") || "none"}`,
    `Pending login: ${observation.pendingLogin ? `${observation.pendingLogin.userCode} at ${observation.pendingLogin.verificationUri}` : "none"}`,
    `Credential saved: ${observation.credentialSaved ? "yes" : "no"}`,
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
