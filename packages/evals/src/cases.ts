import { join } from "node:path";
import { baseCaseFixture, messyHomeFixture, type Fixture } from "./fixtures.ts";
import type { Permissions } from "./codex.ts";
import type { LibraryObservation, Observation } from "./observe.ts";
import type { IssuedLogin } from "./registry.ts";

/** What a case's prompt and reference can refer to on the trial's machine. */
export interface CaseContext {
  readonly home: string;
  /** Origin of the trial's local Registry. */
  readonly registry: string;
}

/** What a case judges, all of it read by the harness rather than claimed by the agent. */
export interface Evidence {
  readonly observation: Observation;
  readonly finalMessage: string | null;
  /** Every login the trial's local Registry started. */
  readonly issued: readonly IssuedLogin[];
}

/** The packaged skit on the trial's machine; returns stdout. */
export type Skit = (...args: string[]) => Promise<string>;

/** One unattended task: the machine, what the user says, what they allow, and how to tell it was done. */
export interface EvalCase {
  readonly id: string;
  readonly fixture: (home: string) => Fixture;
  /** What the user lets Codex do beyond its default sandbox: just what the task needs. */
  readonly permissions: Permissions;
  readonly prompt: (context: CaseContext) => string;
  /**
   * What a correct agent does, run by the control lane without a model to prove `verify` accepts
   * it. Returns what that agent would tell the user.
   */
  readonly reference: (context: CaseContext, skit: Skit) => Promise<string>;
  /** Why the task was not done; empty when it was. */
  readonly verify: (evidence: Evidence) => string[];
}

/**
 * Review the setup plan, then run its apply command as printed, choosing only how duplicates are
 * handled. The control lane uses other choices to prove the cases tell them apart.
 */
export async function applyRecommendedSetup(
  skit: Skit,
  options: { workDir?: string; duplicates?: string } = {},
): Promise<string> {
  const plan = JSON.parse(
    await skit("setup", "--json", ...(options.workDir ? ["--work-dir", options.workDir] : [])),
  ) as { data: { onboarding: { applyCommand: string } } };
  const [, ...args] = plan.data.onboarding.applyCommand
    .replace(/<[^>]*>/, options.duplicates ?? "retain-only")
    .split(" ");
  return skit(...args, "--json");
}

function libraryFailures(
  library: LibraryObservation,
  expected: {
    skills: readonly string[];
    installedSkills: readonly { target: string; path: string }[];
    /** Skills kept in the Library that no agent may see through a skit copy. */
    retainedOnly?: readonly string[];
  },
): string[] {
  if (!library.exists) return ["no Library: setup was not applied"];
  return [
    ...expected.skills
      .filter((name) => !library.skills.includes(name))
      .map((name) => `Library is missing ${name}`),
    ...expected.installedSkills
      .filter(
        (want) =>
          !library.installedSkills.some(
            (have) =>
              have.target === want.target && have.path === want.path && have.status === "installed",
          ),
      )
      .map((want) => `no installed ${want.target} copy at ${want.path}`),
    ...library.installedSkills
      .filter((installedSkill) => installedSkill.status !== "installed")
      .map(
        (installedSkill) =>
          `${installedSkill.target} copy at ${installedSkill.path} is ${installedSkill.status}`,
      ),
    ...(expected.retainedOnly ?? []).flatMap((name) =>
      library.installedSkills
        .filter((installedSkill) => installedSkill.path.endsWith(`/${name}`))
        .map(
          (installedSkill) =>
            `${name} should be kept only, but has a copy at ${installedSkill.path}`,
        ),
    ),
  ];
}

const setupRequest =
  "Set up skit for me. It's installed; run it with `skit`. Go with what it recommends. I'm stepping away, so just go ahead.";

/** Case 0: setup on a machine that has never run skit, with one skill the user wrote. */
export const baseCase: EvalCase = {
  id: "setup-base",
  fixture: baseCaseFixture,
  permissions: { writable: [".agents"], network: false },
  prompt: () => setupRequest,
  reference: async (_context, skit) => {
    await applyRecommendedSetup(skit);
    return "Set up skit with its recommended plan.";
  },
  verify: ({ observation }) =>
    libraryFailures(observation.library, {
      skills: ["release-notes"],
      installedSkills: [
        { target: "agents", path: ".agents/skills/release-notes" },
        { target: "claude", path: ".claude/skills/release-notes" },
      ],
    }),
};

/**
 * Case 1: the same request on a machine with every kind of copy setup has to decide about, and
 * the user's repositories included. `standup` is visible to agents through the user's symlink, so
 * it is kept in the Library only and the link stays.
 */
export const messyHomeCase: EvalCase = {
  id: "setup-messy",
  fixture: messyHomeFixture,
  permissions: { writable: [".agents"], network: false },
  prompt: () => `${setupRequest} Include my repos in ~/Work.`,
  reference: async ({ home }, skit) => {
    await applyRecommendedSetup(skit, { workDir: join(home, "Work") });
    return "Set up skit with its recommended plan, including ~/Work.";
  },
  verify: ({ observation }) => [
    ...libraryFailures(observation.library, {
      skills: ["commit", "release-notes", "standup", "web-design-guidelines"],
      installedSkills: [
        { target: "agents", path: ".agents/skills/commit" },
        { target: "claude", path: ".claude/skills/commit" },
        { target: "agents", path: ".agents/skills/release-notes" },
        { target: "claude", path: ".claude/skills/release-notes" },
      ],
      retainedOnly: ["standup"],
    }),
    ...(observation.repositoryRoots.includes("Work") ? [] : ["skit does not scan ~/Work"]),
  ],
};

/** Whether `text` shows `code`, however it is grouped: skit prints `ABCD-1234` for `ABCD1234`. */
function mentionsCode(text: string, code: string): boolean {
  return text.replace(/[\s-]/g, "").toUpperCase().includes(code.replace(/-/g, "").toUpperCase());
}

/**
 * Case 2: start signing in for sync and hand the user what they need to approve it later. Nobody
 * approves the code, so the task is done when skit is waiting on a code the Registry issued and the
 * user has been told the URL and that code.
 */
export const loginCase: EvalCase = {
  id: "login",
  fixture: baseCaseFixture,
  permissions: { writable: [], network: true },
  prompt: ({ registry }) =>
    `Start a skit login so I can sync my skills. It's installed; run it with \`skit\`. My registry is ${registry}. Give me the URL and code; I'll approve it later.`,
  reference: async ({ registry }, skit) => {
    const pending = JSON.parse(await skit("auth", "login", registry, "--json")) as {
      data: { verificationUri: string; userCode: string };
    };
    return `Open ${pending.data.verificationUri} and enter the code ${pending.data.userCode}.`;
  },
  verify: ({ observation, finalMessage, issued }) => {
    const pending = observation.pendingLogin;
    if (issued.length === 0) return ["no login was started with the Registry"];
    if (!pending || !issued.some((login) => login.userCode === pending.userCode.replace(/-/g, "")))
      return ["skit is not waiting on a login the Registry started"];
    const message = finalMessage ?? "";
    return [
      ...(mentionsCode(message, pending.userCode)
        ? []
        : [`final message does not give the code ${pending.userCode}`]),
      ...(message.includes(pending.verificationUri)
        ? []
        : [`final message does not give the URL ${pending.verificationUri}`]),
      ...(observation.credentialSaved ? ["a credential was saved, but nobody approved"] : []),
    ];
  },
};

export const cases: readonly EvalCase[] = [baseCase, messyHomeCase, loginCase];
