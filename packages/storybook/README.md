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

Preview colour is off by default and follows the CLI terminal colour policy
(`NO_COLOR`, `TERM=dumb`, and `FORCE_COLOR=0` disable it). When colour is enabled,
the embedded terminal uses the detected host ANSI palette and default foreground
and background. If detection is incomplete, colour remains unavailable; the
neutral preview uses detected defaults or the existing storybook text/canvas colours.
The storybook controls retain their existing UI palette.

Run the terminal/key-input smoke check with `pnpm --filter @smolai/skit-storybook test:preview`.
