# skit

SKIT is a better way to manage your agent skills.

- Your skill library is stored separately to the directories harnesses automatically read from, like `.agents/skills`
- Enable and disable a skill in one or more harnesses without removing it from your library
- Control whether agents can invoke skills automatically
- Sync your library and settings across machines, with a self-hosted option

## Why SKIT?

You've no doubt experienced this by now:

People are raving about a skill on X, so you install it.

At some point not too long afterwards, you're working with your agent of choice.

"Since this is related to [foo], I'm going to use the [foo] skill."

But that's not what you wanted:

- maybe the author's description of when the skill should be used was too broad
- maybe the one of skills is called `commit`, or something else you do regularly, and want done in your own way
- maybe you only want to use the skill in certain cases, in certain repos
- maybe the skill requires another application to be open on your machine
- maybe you installed the skill six months ago, and it relies on an MCP server which your harness can't see anymore, because it changed how or where they're configured
- maybe you can't even figure out where it came from in the first place

SKIT exists because we think the UX for skills can and should be better than this.

## Getting started

Install:

```sh
npm i -G @smolai/skit
```

## Setup

The interactive setup flow finds skills in the standard skill locations used by Codex, Claude Code, OpenCode, and Devin.

```sh
skit setup
```

You can optionally provide a directory where you keep your Git repositories using `--work-dir`, e.g. `--work-dir ~/Work`.

```sh
skit setup --work-dir ~/Work
```

When provided, SKIT checks your work directory and its immediate children for Git repositories. In each repository, it finds skills and skills.sh lockfiles, and identifies whether they are committed, untracked, or ignored by Git.

For each discovered repository, you can configure SKIT to track or ignore them in future.

### Discovered Skills

Select any discovered skill to add its exact current version to your SKIT library. For an unmanaged global skill, SKIT also takes custody of its harness installation.

If enabling would create another same-scope copy in an agent’s known skill directories, setup asks whether to retain without enabling, explicitly keep both copies, or retire redundant symlinks. Symlinks are retired only after replacement Projections succeed; their targets stay in place, and the links are saved with recovery receipts. Setup never offers this cleanup for a real source directory.

### skills.sh

When SKIT can determine the source of a skill from a skills.sh lockfile, you can add these sources to your SKIT library for updates.

If SKIT finds multiple versions of skills from the same source across the repositories on your machine, it preserves each version in your library.

### Limitations

- SKIT does not currently support taking custody of skills found in repositories during setup. After adding one to your Library, remove it from the repository and enable it using `skit enable`.

## Skill activity

Run `skit usage` to see observed skill calls, instruction loads, and document reads from local Claude Code and Codex transcripts over the last seven days. Use `--days 30`, `--harness codex`, `--project .`, or `--json` to narrow the report or read structured output. See [local skill activity](docs/skill-usage.md) for evidence categories and coverage limits.

## Enabling and disabling skills

Use the interactive flows:

```sh
skit enable
```

```sh
skit disable
```

Enabled skills are available to every agent. SKIT writes one copy into `.agents/skills`, which Codex, OpenCode, Devin, Cursor and Pi read, and, when Claude Code is installed, one into `.claude/skills`.

Interactive `skit enable`, `skit disable`, `skit list`, and the TUI offer whole-collection actions as well as individual Skill selection. When you enable a whole collection, `skit update` enables new skills added to it and disables skills removed from it. Selecting individual skills enables only those skills.

Alternatively, you can supply these flags:

- `--repo [path]` to enable in a single repo
- `--all` to enable a whole collection, including new skills added when you update
- `--invocation [declared, explicit, implicit, host-policy]` to control whether an agent can invoke the skill automatically

Before enabling a new skill, SKIT checks the same-scope directories readable by each agent. An existing copy blocks enable, including an identical copy reached through a symlink. `skit enable --dry-run` shows the conflict; `--allow-duplicate` explicitly permits it. Existing Bindings can still change invocation policy. `skit doctor` shows duplicate symlink locations and their resolved targets.

The interactive `skit list` flow allows you to change invocation settings for all skills.

### How this works

Each harness supported by SKIT has its own unique way to disable an agents ability to use a skill without you explicitly invoking it.

Claude Code uses `SKILL.md` frontmatter:

```
disable-model-invocation: true
```

Codex uses `agents/openai.yaml` in the skill folder:

```yaml
policy:
  allow_implicit_invocation: false
```

Devin uses `SKILL.md` frontmatter:

```
triggers: [user]
```

OpenCode V2 uses `SKILL.md` frontmatter:

```
metadata:
  opencode/autoinvoke: "false"
```

Note: OpenCode V1 does not have any support for this feature.

When you enable a skill, SKIT copies the skill from your library to the right places, and adds the right setting for your harness or harnesses.

When you disable a skill, SKIT removes the copy.

## Sync

SKIT allows you to sync your skills across multiple machines.

Create an account at `https://skit.smol.ai`, and log in using `skit auth login https://skit.smol.ai`.

Alternatively, you can self-host the SKIT server.

The [SKIT server](packages/skit-server-effect/README.md) is open source, and supports self-hosting on Cloudflare.

This repository is licensed under the [MIT licence](LICENSE).
