# Using SKIT with coding agents

Coding agents such as Codex and Claude Code can set SKIT up for you, but they run commands in a
sandbox and without a person at the prompt. This page explains what SKIT does differently when an
agent drives it and how to give the agent the permission it needs.

## What happens when an agent runs SKIT

- **SKIT never prompts.** When it detects an agent or other automation (`CODEX_CI`,
  `CODEX_THREAD_ID`, `CLAUDECODE`, `AI_AGENT`, `CI` or `SKIT_NO_INPUT`), every command takes its
  non-interactive path even if the agent gave it a terminal. Agents therefore can't click through a
  confirmation on your behalf.
- **Setup is review, then apply.** `skit setup` (or `skit setup --json`) reports the recommended
  plan and the exact command that applies it. `skit setup --apply <planId>` applies that plan and
  nothing else; it fails if anything changed after the plan was made. Skills that agents can
  already see elsewhere need an explicit `--duplicates retain-only|keep-both|retire-aliases`.
  Setup never removes anything with `--apply`.
- **`--apply` reports what it did.** The result lists what was imported and added, every copy it
  wrote with its status, and why each other skill was left alone.
- **Repositories are opt-in.** Setup reports folders under your home that contain Git
  repositories (`suggestedRepositoryRoots`) but scans them only with `--work-dir`.

## Letting Codex apply the plan

SKIT writes copies into `~/.agents/skills`. Codex's default `workspace-write` sandbox keeps the
top-level `.agents`, `.codex`, `.git` and `.aws` directories read-only inside every writable root,
so a sandboxed agent can review a plan but not apply it. SKIT reports this as
`SKIT cannot write to …/.agents/skills: permission denied`, and the agent hands you the command to
run yourself.

To let Codex run SKIT's setup and enable commands outside the sandbox, add a rules file such as
`~/.codex/rules/skit.rules`:

```python
prefix_rule(
    pattern = ["skit", "setup"],
    decision = "allow",
    justification = "Let Codex run skit setup",
)

prefix_rule(
    pattern = ["skit", "enable"],
    decision = "allow",
    justification = "Let Codex run skit enable",
)
```

Codex runs a command outside its sandbox only when every part of it matches an allow rule, so
anything else the agent runs stays sandboxed. The rule applies only to literal commands: Codex
does not treat a word containing `~`, `$`, `*` or similar characters as literal, because the shell
could expand it. `skit setup --apply ~/Work …` therefore stays sandboxed. SKIT prints its apply
command with absolute paths (`onboarding.applyCommand` in JSON); ask the agent to run it exactly as
printed.

## Teaching the agent

The [`skit` skill](../skills/skit/SKILL.md) tells an agent how to operate SKIT: review the plan,
run the printed apply command unchanged, only choose a `--duplicates` option you agreed to, and
verify the result. Add it to your Library like any other skill:

```sh
skit add smol-ai/skit
skit enable skit
```

## What agents should not do

- Copy, move or delete skill folders by hand, or edit `~/.skit/state.json`. SKIT keeps the only
  record of what it manages and refuses changes it cannot account for.
- Retry `--apply` after it succeeds. The plan ID changes once the plan is applied, so a second run
  fails as stale; `skit inventory --json` shows the current state instead.
