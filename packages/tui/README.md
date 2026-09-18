# SKIT audit TUI prototype

Throwaway OpenTUI prototype for exploring an interactive audit of installed Skills, MCP servers, and Harness configuration.

Run from the repository root:

```sh
pnpm tui
```

This package runs SKIT's existing passive capability audit against the repository and user home. It reads Harness configuration and installed Skills, MCP registrations, plugins, marketplaces, and rules. It does not run executable probes or mutate audit targets.

Override the audit roots with `--cwd <path>` or `--home <path>`.

The prototype contains five inventory views: Harnesses, Skills, Claude plugins, Codex plugins, and MCPs. Switch with `1`–`5`, `[` or `]`; open the command palette with `Ctrl-P`; quit with `q` or `Ctrl-C`.

Drag across text with the mouse, then press `y` to copy (yank) the selection.
`Ctrl-C` remains an unambiguous quit shortcut.

The Skills view opens on provenance groups: Skill Collections, parent plugins,
and named acquisition sources, plus explicit `All skills` and `Unattributed`
entries. Press `Enter` to drill into a group, then `Enter` again to read the
selected `SKILL.md`. Press `Esc` to return from a document to its group or from
a group to the group list. Scroll documents with the arrow or page keys.

The Harnesses view keeps executable inspection explicit: press `p` to probe the selected harness or `P` to probe all displayed harnesses. A probe runs the harness's bounded `--version` command and reports its executable, resolved installation target, inferred installer, and product version.

Open a specific view with `--view harnesses`, `skills`, `claude-plugins`, `codex-plugins`, or `mcps`.

Render one frame without opening a terminal:

```sh
SKIT_TUI_SNAPSHOT=/tmp/skit-audit.txt SKIT_TUI_SNAPSHOT_SIZE=140x38 pnpm tui
```

Set `SKIT_TUI_SNAPSHOT_PALETTE=1` to capture the command palette overlay.
Set `SKIT_TUI_SNAPSHOT_DOCUMENT=1` to capture the selected Skill document and
`SKIT_TUI_SNAPSHOT_HARNESS_PROBE=1` to capture Harness probe results. Use
`--item <name>` with `--view` to select a particular row before capture.
