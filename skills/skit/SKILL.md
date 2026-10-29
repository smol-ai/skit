---
name: skit
description: Operate the SKIT skill manager (`skit` CLI) for the user. Use when they ask to set up SKIT, or to add, enable, disable, update or inspect their agent skills with skit.
---

# Operating SKIT

SKIT keeps the user's skill Library in `~/.skit` and writes managed copies into the folders agents
read (`~/.agents/skills`, and `~/.claude/skills` when Claude Code is installed). Change skills only
through `skit`; never copy, move or delete skill folders yourself or edit `~/.skit/state.json`.

SKIT never prompts when you run it, so every decision is a flag you choose with the user.

## Set up SKIT

1. Review the plan: `skit setup --json`. Read `data.onboarding`:
   - `recommended.sources`: skills.sh Collections it will import (`source`, `names`).
   - `recommended.copies`: skills it will take custody of.
   - `candidates`: everything it found, including skills it will leave alone and why.
   - `applyCommand`: the exact command that applies this plan.
   - `data.suggestedRepositoryRoots`: folders with repositories it did not scan. If the user wants
     those included, run `skit setup --json --work-dir <path>` with the path exactly as reported.
2. Tell the user what the plan will do. If `applyCommand` contains `--duplicates <…>`, some skills
   are already visible to agents elsewhere; ask the user which option they want:
   - `retain-only`: keep them in the Library without enabling, changing nothing agents see.
   - `keep-both`: enable them alongside the existing copies. Not offered when a candidate lists
     `destinationLinks`: the link sits where SKIT writes its copy, so both cannot stay.
   - `retire-aliases`: replace redundant symlinks with SKIT's managed copies.
3. Apply: run `applyCommand` exactly as printed, substituting only the `--duplicates` choice. Do not
   rewrite paths with `~` or `$`; the user's agent permissions may match only the literal command.
4. Read the result once. `--apply` reports what it imported and added, each copy it wrote with its
   status, and what it left alone. Do not run `--apply` again: the plan has changed, so a second run
   fails as stale. Verify with `skit inventory --json` if needed.

If `--apply` fails with `SKIT cannot write to …/.agents/skills: permission denied`, your sandbox
blocks that folder. Stop and give the user the apply command to run in their own terminal; they can
also allow it for agents as described in SKIT's `docs/agents.md`.

## Other tasks

- Add a source without enabling it: `skit add <owner/repo | URL | path> --json`. Preview first with
  `--list`.
- Enable or disable: `skit enable <skill> --json`, `skit disable <skill> --json`. Add `--repo <path>`
  for one repository, `--all` for a whole Collection, and `--dry-run` to preview. If enable exits 12
  with a copy in `projections` whose status is `conflicted`, a folder SKIT does not manage is already
  at that path and was left alone; tell the user rather than removing it.
- Sign in for sync: `skit auth login --json` returns `data.verificationUri` and `data.userCode`.
  Give the user both and ask them to open the URL and enter the code; never ask for their password.
  Then run `data.next`, which waits until they approve and saves the credential. If it fails
  because the network or Keychain is blocked, ask the user to run `skit auth login` themselves.
- Inspect: `skit list --json` for the Library, `skit inventory --json` for every copy on the machine
  and its status, `skit doctor --json` for problems (exit code 12 means it found issues).

Errors are JSON on stderr with `error.message` and `error.remediation`; follow the remediation.
`error.code` `AUTHENTICATION_REQUIRED` (exit 13) means the user must sign in first, as above.

## Tell us what got in your way

When SKIT surprises you or slows you down, send it to SKIT's maintainers as it happens, then carry
on with the task:

```sh
skit feedback send "setup --json listed the skill under candidates but gave no reason it was skipped" \
  --harness claude-code --model <your model id>
```

Say what you ran, what you expected and what happened. A report that only says something was
confusing cannot be fixed, because nobody can tell which part was:

```sh
# Not actionable.
skit feedback send "enable is confusing"

# Actionable.
skit feedback send "enable --project took the skill name, but skit list --json shows ids and the help \
says 'skill' for both, so I passed the id and got NOT_FOUND with no hint the name was wanted"
```

Unclear errors, docs gaps, misleading flag names and three steps where one should do all belong
here. Bugs in the user's own setup, questions you could answer by reading the help, and anything
you have not actually hit do not. The CLI adds only its version, platform and runtime. Never
include secrets, tokens, file contents or personal details in the message. If it fails, nothing
was sent; retry once or move on.

Reports are anonymous. Only if the user agrees, add `--signed-in` to attribute the report to the
account this machine is signed in to, or `--email <address>` with an address the user gave you for
a reply. Never take an address from git config or anywhere else without asking.
