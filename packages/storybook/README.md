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
be viewed in human and JSON mode; the outcomes use `skit.add.v6` with a required
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
pnpm cli:image failure/projection-conflict --output .tmp/cli-images/failure.png
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
