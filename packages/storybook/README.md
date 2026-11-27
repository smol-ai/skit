# SKIT output storybook

> **Slop devtool:** this is a deliberately rough internal tool for quickly inspecting CLI
> output fixtures and scripted interactive journeys. It is not a supported package or part of
> SKIT's consumer-facing TUI.

Run it from the repository root with:

```sh
pnpm cli:stories
```

Journey stories have an animated terminal preview. Search for
`journey/library-sync/fresh-device` or `journey/library-sync/download-failed`, then
press **Tab** to focus the preview.

- **Right / Enter**: next visible change; **Left**: previous change.
- **Space**: play or pause (one change per second). The spinner animates even while paused.
- **Home**: restart; **T**: switch between preview and the complete transcript.
- **Tab**: return to search; **Ctrl+F**: human/JSON; **Ctrl+D**: summary/full; **Ctrl+L**: preview colour on/off.
- **Up / Down**: scroll JSON or transcript when the preview has focus.

Journeys execute once per viewer session against isolated fixtures. Replaying or
stepping backwards does not repeat their work. The sync fixtures use the real CLI
workflow with an in-memory Registry and disposable Library/installation roots.
Prompts show their recorded choices and scripted answers; playback does not ask
for new answers. Playback timing is illustrative, not a performance measurement.

Preview colour is off by default. **Ctrl+L** explicitly enables or disables it,
even when automatic palette detection is incomplete. This preview override does
not change the real CLI's terminal colour policy.

The embedded terminal uses detected host colours where available. Missing ANSI
slots use OpenTUI's fallback palette; missing foreground/background colours use
the existing storybook text/canvas colours. The header labels the palette as
**host**, **mixed**, or **fallback** when colour is on.
The storybook controls retain their existing UI palette.

Run the terminal/key-input smoke check with `pnpm --filter @smolai/skit-storybook test:preview`.

The `add/added`, `add/updated` and `add/unchanged` fixtures show each source
acquisition outcome, returned directly by the retention workflow. Each fixture can
be viewed in human and JSON mode; the outcomes use `skit.add.v7` with a required
`action` field.

## Static image export

The image exporter uses the real CLI presenters and recorded journey frames, with
colour explicitly enabled. It writes the ANSI output into a headless xterm.js
terminal at the selected width, draws the resulting cell grid as SVG with a
fixed dark palette, and rasterizes a 2× PNG with resvg. No browser is involved.
Text uses DejaVu Sans Mono, with DejaVu Sans for the braille spinner, both from
the `dejavu-fonts-ttf` package. System fonts are never loaded, so output is
identical across platforms. These are storybook development dependencies; the
distributed CLI does not include them.

From the repository root:

```sh
pnpm cli:image --list
pnpm cli:image add/added --command 'skit add ~/Work/skills/review' --output .tmp/cli-images/added.png
pnpm cli:image failure/installed-skill-conflict --output .tmp/cli-images/failure.png
pnpm cli:image journey/preview-enable-portable-collection --frames
pnpm cli:image journey/preview-enable-portable-collection --frame 1 --command 'skit enable' --output .tmp/cli-images/prompt.png
```

Story keys must match exactly. Journeys default to their final frame; `--frames`
prints available frame indices and labels. Each journey runs once in disposable
fixtures to obtain its recording. Frame selection does not drive the real CLI or
repeat the operation. An optional `--command` is a display caption only.

Relative output paths resolve against the directory `pnpm` was invoked from.
Each PNG has an SVG sibling with DejaVu Sans Mono embedded, for inspecting or
sharing the render. Use `--columns 72` to change the content width (default
88), and `--detail full` for full command output. Long lines wrap exactly as a
terminal of that width would.

This tool exports presenter output, not arbitrary live terminal sessions. It
preserves the CLI's existing colours rather than adding highlighting to
uncoloured errors. Some journey frames contain temporary paths or
fixture-generated identifiers; those need normalization before use as
reproducible documentation assets. The exporter does not upload images or
update Markdown automatically.

## CLI Atlas

Run `pnpm cli:atlas` from the repository root to start the viewer immediately.
Open the localhost URL it prints. This serves existing `atlas-data/` and does not
build the CLI, record flows or run tests. The package commands `atlas` and
`atlas:dev` start the same Vite development server.

Generate data once on a fresh checkout, or explicitly refresh it after changing
the CLI, recordings or saved test reports:

```sh
pnpm cli:atlas:generate
```

Generation runs the replayable flows and can take a few minutes. It is separate
from starting the viewer. To build a static site from existing data, run
`pnpm cli:atlas:build`; the result is `packages/storybook/atlas/`.

Atlas explains commands, checked failures, persisted formats and recorded flows.
Command/error links come from TypeScript types before application providers;
dependency errors are listed separately. Store ownership is curated as exported
code symbols and validated during generation. Owner errors describe an interface,
not command-to-store access. Flows show shared prefixes as a tree, and repeated
progress ticks expand without changing step URLs. Vocabulary comes from
`CONTEXT.md`; coverage counts and missing stories have their own page.

Data and terminal frames are generated from the checkout and isolated journey
fixtures. Atlas does not inspect your installed Skills or saved Library data.

## Atlas test results

Atlas collects guarantee names and their tests from the current CLI and core test suites during generation, without running the tests. Commands with declared guarantees show a Guarantees tab even when no report exists. Matching results from a current clean checkout add pass, failure or skip statuses.

The evidence runner and collector discover `test/**/*.test.ts` under the CLI and core packages. Fixture directories and separate opt-in `.e2e.ts` entrypoints are excluded. For `skit sync`, add a named guarantee to `packages/skit/test/fixtures/sync-guarantees.json` and pass it to Vitest with `describe(g.title, { meta: { guarantee: g } }, tests)`. The catalog records each guarantee’s command, stable key, section and display order. Atlas validates section order and reports copy issues when generating. The Coverage page lists files containing tests outside a command guarantee.

Run `pnpm cli:atlas:guarantees` to refresh declarations and saved outcomes in the existing index. The first run builds the full Atlas if the index is missing.

Atlas reads saved results from Vitest's standard JSON reporter. To save local author
test results (including author sync/watch and the replayable scenarios), run:

```sh
pnpm --filter @smolai/skit build
pnpm --filter @smolai/skit test:atlas
pnpm --filter @smolai/skit-core test:atlas
pnpm cli:atlas:generate
pnpm cli:atlas
```

The CLI and core reports live at `packages/cli/.atlas/vitest.json` and
`packages/skit/.atlas/vitest.json`. Both are ignored. The scripts use the
shared Atlas Vitest config, including the isolated HOME. Collection does not execute test bodies. Missing reports show “No saved test report”. Invalid reports fail
the build. CI does not publish these reports.

Each report records the Git revision and whether the checkout was dirty during
the run. Atlas shows test results against the current clean revision. Reports
from a different revision are marked stale. Older reports and reports involving
dirty checkouts are unverified. Scenario flow pages show a saved pass or failure
only when the report matches the current clean checkout.
