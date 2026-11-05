/**
 * Variables that say no person is answering prompts in this shell. Agent harnesses mark the shells
 * they run commands in: Codex sets `CODEX_CI` and `CODEX_THREAD_ID`, Claude Code sets `CLAUDECODE`,
 * and `AI_AGENT` is a harness-neutral convention. `CI` covers automation generally, and
 * `SKIT_NO_INPUT` lets anyone opt out explicitly.
 */
const automationVariables = [
  "SKIT_NO_INPUT",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "CLAUDECODE",
  "AI_AGENT",
  "CI",
] as const;

const isSet = (value: string | undefined) =>
  value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

/** The first variable showing that an agent or automation drives this shell, if any. */
export const automationMarker = (
  env: NodeJS.ProcessEnv = process.env,
): (typeof automationVariables)[number] | undefined =>
  automationVariables.find((name) => isSet(env[name]));

export interface PromptContext {
  readonly json: boolean;
  /** Whether this command also needs stdout to be a terminal, not only its stderr prompt channel. */
  readonly needsStdout?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly streams?: {
    readonly stdin: boolean;
    readonly stdout: boolean;
    readonly stderr: boolean;
  };
}

/**
 * Whether a command may ask questions. A terminal alone does not prove a person is answering:
 * Codex gives commands a pseudo-terminal, and an agent that clicks through a confirmation consents
 * on the user's behalf without showing them what it approved. Under an agent or automation every
 * command takes its non-interactive path, which reports what it would do and how to do it
 * explicitly.
 */
export function promptsAllowed(context: PromptContext): boolean {
  const streams = context.streams ?? {
    stdin: Boolean(process.stdin.isTTY),
    stdout: Boolean(process.stdout.isTTY),
    stderr: Boolean(process.stderr.isTTY),
  };
  return (
    !context.json &&
    streams.stdin &&
    streams.stderr &&
    (!context.needsStdout || streams.stdout) &&
    automationMarker(context.env) === undefined
  );
}

/**
 * Whether a person can act on a request outside this shell, such as approving a login in their
 * browser. An agent relays it to the person it works for; under CI or `SKIT_NO_INPUT` nobody is
 * there to act, so a command that would wait on them fails instead.
 */
export const personReachable = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !isSet(env.CI) && !isSet(env.SKIT_NO_INPUT);
