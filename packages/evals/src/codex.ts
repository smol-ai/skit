import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { agentPath } from "./skit-package.ts";
import type { RunRoot } from "./run-root.ts";

export interface CodexSession {
  readonly prompt: string;
  /**
   * What the user says next, in order. Each is sent on the same thread only when the agent's last
   * message asks something, as a person replying in the conversation would.
   */
  readonly replies: readonly string[];
  /**
   * Whether the user has told Codex it may run skit's setup and enable commands. Codex command
   * rules with `decision = "allow"` skip approval and run outside the sandbox, but only when every
   * segment of the command matches an allow rule; everything else the agent runs stays sandboxed.
   */
  readonly allowSkit: boolean;
  readonly model?: string;
  readonly timeoutMs: number;
}

/** The rules file a user would put in `~/.codex/rules/` to let Codex run skit setup and enable. */
export const skitCommandRules = `prefix_rule(
    pattern = ["skit", "setup"],
    decision = "allow",
    justification = "The user lets Codex run skit setup",
)

prefix_rule(
    pattern = ["skit", "enable"],
    decision = "allow",
    justification = "The user lets Codex run skit enable",
)
`;

export interface CodexTurnOutcome {
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface CodexOutcome {
  readonly codexVersion: string;
  readonly turns: readonly CodexTurnOutcome[];
  /** The last turn's exit code. */
  readonly exitCode: number | null;
  /** Whether any turn timed out. */
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Parsed `codex exec --json` events of every turn, in order. */
  readonly events: readonly CodexEvent[];
}

/**
 * The fields of a `codex exec --json` event that reports read. Everything else in the event is
 * kept in the raw stream file; nothing here claims a complete schema.
 */
export interface CodexEvent {
  readonly type?: string;
  readonly thread_id?: string;
  readonly usage?: unknown;
  readonly item?: {
    readonly type?: string;
    readonly command?: string;
    readonly exit_code?: number | null;
    readonly aggregated_output?: string;
    readonly text?: string;
  };
  /** Set only for a stream line the harness could not parse. */
  readonly line?: string;
}

const killGraceMs = 5_000;

/** The developer's Codex, by absolute path, so it never has to be on the agent's PATH. */
export function codexExecutable(): string {
  return (
    process.env.SKIT_EVAL_CODEX ?? execFileSync("which", ["codex"], { encoding: "utf8" }).trim()
  );
}

/**
 * Run one non-interactive Codex session inside the run root: the prompt, then each scripted reply
 * resumed on the same thread.
 *
 * The agent's working directory and `$HOME` are the run's home, so "set up skit for me" acts on a
 * machine we built. The sandbox is always `workspace-write` rooted at that home, which is Codex's
 * default: it also keeps `.agents` and `.codex` read-only inside the writable root, exactly as a
 * user running Codex with defaults gets. Agent-written commands never run unsandboxed, because
 * only `$HOME` is fake and absolute paths would reach the real machine; with `allowSkit`, only
 * `skit setup` and `skit enable` do, as a user's rule would allow. The environment is built from scratch rather
 * than inherited, so ambient `SKIT_HOME`, `XDG_*` or `CODEX_HOME` cannot leak into a trial.
 * Stdin is closed, as it would be for any agent-driven shell.
 */
export async function runCodexSession(run: RunRoot, session: CodexSession): Promise<CodexOutcome> {
  const executable = codexExecutable();
  const codexVersion = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  const credentials = seedCredentials(run);
  // CODEX_HOME is isolated, so its rules directory holds only what this trial writes there.
  if (session.allowSkit) {
    mkdirSync(join(run.codexHome, "rules"), { recursive: true });
    writeFileSync(join(run.codexHome, "rules", "skit.rules"), skitCommandRules);
  }
  const options = [
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--sandbox",
    "workspace-write",
    "--cd",
    run.home,
    "--add-dir",
    run.tmp,
    "-c",
    'approval_policy="never"',
    ...(session.model ? ["--model", session.model] : []),
  ];
  const env: NodeJS.ProcessEnv = {
    HOME: run.home,
    CODEX_HOME: run.codexHome,
    PATH: agentPath(run),
    TMPDIR: run.tmp,
    USER: userInfo().username,
    LOGNAME: userInfo().username,
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
  };

  const turns: CodexTurnOutcome[] = [];
  const events: CodexEvent[] = [];
  const started = Date.now();
  try {
    let prompt = session.prompt;
    let threadId: string | undefined;
    for (let index = 0; ; index++) {
      const args = ["exec", ...options, ...(threadId ? ["resume", threadId] : []), prompt];
      const streamPath = join(run.evidence, `codex-stream-${index + 1}.jsonl`);
      const turnStarted = Date.now();
      const { exitCode, timedOut } = await settle(
        executable,
        args,
        env,
        run.home,
        session.timeoutMs,
        streamPath,
        join(run.evidence, `codex-stderr-${index + 1}.txt`),
      );
      const turnEvents = readJsonl(streamPath);
      events.push(...turnEvents);
      turns.push({
        command: [executable, ...args],
        exitCode,
        timedOut,
        durationMs: Date.now() - turnStarted,
      });
      threadId ??= turnEvents.find((event) => event.type === "thread.started")?.thread_id;
      const reply = session.replies[index];
      if (reply === undefined || exitCode !== 0 || timedOut || !threadId || !asksUser(turnEvents))
        break;
      prompt = reply;
    }
    const last = turns.at(-1)!;
    return {
      codexVersion,
      turns,
      exitCode: last.exitCode,
      timedOut: turns.some((turn) => turn.timedOut),
      durationMs: Date.now() - started,
      events,
    };
  } finally {
    rmSync(credentials, { force: true });
  }
}

/**
 * Whether the turn ended by asking the user something: a question, or a request such as "Please
 * choose how to handle…". A person would answer either.
 */
function asksUser(events: readonly CodexEvent[]): boolean {
  const messages = events.filter((event) => event.item?.type === "agent_message");
  const text = messages.at(-1)?.item?.text ?? "";
  return /\?|\b(please (choose|confirm|decide|tell me|let me know)|let me know|which (option|one)|choose)\b/iu.test(
    text,
  );
}

/**
 * Codex reads credentials from `$CODEX_HOME`, which is redirected, so an isolated run has none
 * unless we copy them in. The copy lives only for the process lifetime.
 */
function seedCredentials(run: RunRoot): string {
  const source = join(userInfo().homedir, ".codex", "auth.json");
  if (!existsSync(source))
    throw new Error(`no Codex credentials at ${source}; run \`codex login\``);
  const target = join(run.codexHome, "auth.json");
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  return target;
}

function settle(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  streamPath: string,
  stderrPath: string,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = createWriteStream(streamPath);
    const stderr = createWriteStream(stderrPath);
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), killGraceMs).unref();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Flush both captures before anyone reads them, so a truncated tail never reads as absent events.
      let pending = 2;
      const done = () => {
        if (--pending === 0) resolve({ exitCode: code, timedOut });
      };
      stdout.end(done);
      stderr.end(done);
    });
  });
}

function readJsonl(path: string): CodexEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): CodexEvent => {
      try {
        return JSON.parse(line) as CodexEvent;
      } catch {
        return { type: "harness.unparsed_line", line };
      }
    });
}
