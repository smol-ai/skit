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

Sync/setup output fixtures include `library-sync/upload-preview`, `download-preview`,
`merge-preview`, `merged-with-local-edits`, `clean-with-local-edits`, `many-local-edits`,
and `enablement-incomplete`. Search `journey/setup/guidance` for the setup overview
and completion copy (presentation only; it does not apply setup).

`journey/library-sync/explicit-progress` runs a real fixture sync with `--progress`.
Its progress lines persist on stderr even in JSON mode, while the result on stdout
remains valid JSON. The terminal preview interleaves both streams; captured replay
frames also expose them separately. The ordinary fresh-device story keeps progress
disabled so it still demonstrates JSON output without progress.
